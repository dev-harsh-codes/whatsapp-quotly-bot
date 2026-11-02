import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import express from 'express'
import fs from 'fs'
import pino from 'pino'
import QRCode from 'qrcode'
import sharp from 'sharp'
import { createQuoteStickerWebp } from './src/quoteSticker.js'

const PORT = process.env.PORT || 8080
const BACKEND_URL = process.env.BOT_BACKEND_URL || 'https://app-swh26tpxllax7tyvm7gtplqlscdzvz5uwrgo2nycfeq55jk2zrmq.makeproxy-c.figma.site'
let PAIRING_NUMBER = (process.env.PAIRING_NUMBER || '').replace(/[^0-9]/g, '')
const DEFAULT_THEME = process.env.DEFAULT_QUOTE_THEME || 'whatsapp-dark'
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.APP_GEMINI_API_KEY || '').trim()
const AUTH_DIR = './auth_info_baileys'

let latestQrDataUrl = null
let latestPairingCode = null
let connectionState = 'initializing'
let activeSock = null
let currentSocketId = 0
let reconnectTimer = null
let authMode = 'qr' // 'qr' or 'pair' — never run both on the same socket!
const contactDirectory = new Map() // jid -> { name, notify, verifiedName }
const processedMsgIds = new Set()

// Prevent transient Baileys internal sendRetryRequest (428) errors from crashing Heroku dyno
process.on('unhandledRejection', (err) => {
  console.warn('[SafeGuard] Ignored unhandledRejection:', err?.message || err)
})
process.on('uncaughtException', (err) => {
  console.warn('[SafeGuard] Ignored uncaughtException:', err?.message || err)
})

function destroyActiveSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (activeSock) {
    try {
      activeSock.ev.removeAllListeners('connection.update')
      activeSock.ev.removeAllListeners('creds.update')
      activeSock.ev.removeAllListeners('messages.upsert')
      activeSock.ws?.close()
    } catch {}
    activeSock = null
  }
}

function scheduleReconnect(delayMs = 3000) {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startBot()
  }, delayMs)
}

function upsertContactInfo(jid, info = {}) {
  if (!jid) return
  const cleanJid = jid.split(':')[0].includes('@') ? jid.split(':')[0] : jid
  const prev = contactDirectory.get(cleanJid) || {}
  contactDirectory.set(cleanJid, {
    name: info.name || prev.name || '',
    notify: info.notify || prev.notify || '',
    verifiedName: info.verifiedName || prev.verifiedName || '',
  })
}

function formatPhoneNumber(jid = '') {
  const raw = String(jid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
  if (!raw) return 'WhatsApp User'
  if (raw.length === 12 && raw.startsWith('91')) {
    return `+91 ${raw.slice(2, 7)} ${raw.slice(7)}`
  }
  return `+${raw}`
}

function resolveBestDisplayName(jid, sockUser) {
  if (!jid) return 'WhatsApp User'
  const normalized = jid.split(':')[0].includes('@') ? jid.split(':')[0] : jid
  const entry = contactDirectory.get(normalized) || contactDirectory.get(jid) || {}

  // Priority 1: Saved Contact Name
  if (entry.name && entry.name.trim()) return entry.name.trim()

  // Priority 2: WhatsApp Nickname (notify / pushName / verifiedName)
  if (entry.notify && entry.notify.trim()) return entry.notify.trim()
  if (entry.verifiedName && entry.verifiedName.trim()) return entry.verifiedName.trim()

  // If it's the bot/owner's own number
  const selfBase = sockUser?.id?.split(':')[0]?.split('@')[0]
  const targetBase = normalized.split('@')[0]
  if (selfBase && targetBase === selfBase && sockUser?.name) {
    return sockUser.name
  }

  // Priority 3: Formatted Mobile Number
  return formatPhoneNumber(normalized)
}

async function fetchAvatarDataUrl(sock, jid) {
  if (!jid) return undefined
  try {
    const ppUrl = await sock.profilePictureUrl(jid, 'image')
    if (!ppUrl) return undefined
    const res = await fetch(ppUrl)
    if (!res.ok) return undefined
    const arrayBuf = await res.arrayBuffer()
    const pngBuf = await sharp(Buffer.from(arrayBuf))
      .resize(96, 96, { fit: 'cover' })
      .png()
      .toBuffer()
    return `data:image/png;base64,${pngBuf.toString('base64')}`
  } catch {
    return undefined
  }
}

async function generateGeminiReply({ prompt, quotedText = '', mode = 'ai' }) {
  const systemInstruction =
    mode === 'roast'
      ? 'Tum MODI CHATBOT ho aur bilkul Narendra Modi ji ke iconic bhashan wale tone mein Hinglish mein baat karte ho ("Mitron!", "Mere pyare deshwasiyon", "Bhaiyon aur behno", "Aapda mein avsar", "Atmanirbhar"). Diye gaye message par Modi ji ke andaaz mein 2-3 line ka funny, savage par clean roast likho.'
      : mode === 'qai'
        ? 'Tum MODI CHATBOT ho. Bilkul Modi ji ke iconic tone ("Mitron...", "Bhaiyon aur behno...") mein sirf 1 short punchy, funny Hinglish line (max 18 words) likho jo WhatsApp sticker par mast lage. Koi extra explanation mat dena.'
        : 'Tum MODI CHATBOT ho — tum hamesha Narendra Modi ji ke iconic speech tone aur style mein Hinglish mein jawab dete ho! Apne jawab ki shuruat "Mitron!", "Mere pyare deshwasiyon!", ya "Bhaiyon aur behno!" se karo, aur Modi ji ke signature phrases ("Dekhiye...", "140 crore deshwasi", "Atmanirbhar", "Digital India", "Amrit Kaal", "Aapda mein avsar") ka natural aur witty istemal karte hue short, crisp aur mazedar jawab do.'

  const userPrompt = quotedText
    ? `Quoted Message: "${quotedText}"\n\nUser Request: ${prompt || 'Reply to this'}`
    : prompt

  // 1. Direct Gemini Free Tier call (supports both AQ... auth keys and AIza... keys)
  if (GEMINI_API_KEY) {
    for (const model of ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash']) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: { temperature: 0.8, maxOutputTokens: 350 },
          }),
        })
        if (res.ok) {
          const data = await res.json()
          const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim()
          if (text) return text
        } else {
          console.warn(`[Gemini ${model}] HTTP ${res.status}:`, (await res.text()).slice(0, 120))
        }
      } catch (err) {
        console.warn(`[Gemini ${model}] failed:`, err.message)
      }
    }
  }

  // 2. Built-in Keyless Free AI Engine (Works 100% even if GEMINI_API_KEY is missing or invalid!)
  try {
    const pollRes = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.8,
      }),
    })
    if (pollRes.ok) {
      const pollData = await pollRes.json()
      const reply = pollData?.choices?.[0]?.message?.content?.trim()
      if (reply) return reply
    }
  } catch (err) {
    console.warn('[Fallback AI] error:', err.message)
  }

  return 'Mitron! 140 crore deshwasiyon ke ek saath sawal puchne se server par thoda load hai, kripya 5 second baad punah prayaas karein!'
}

function clearAuthFolder() {
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    console.log('[Auth] Cleared stale auth_info_baileys folder for fresh link')
  } catch (err) {
    console.error('[Auth] Failed clearing auth dir:', err.message)
  }
}

const app = express()

app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>QuotLy Bhai WhatsApp Bot - Heroku Status</title>
      <meta http-equiv="refresh" content="6" />
      <style>
        body { font-family: system-ui, sans-serif; background: #0b141a; color: #e9edef; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
        .card { background: #1f2c34; padding: 28px; border-radius: 20px; max-width: 460px; width: 100%; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
        .badge { display: inline-block; padding: 6px 14px; border-radius: 999px; background: #00a884; color: #fff; font-weight: 700; font-size: 13px; margin-bottom: 16px; }
        .code { font-size: 28px; letter-spacing: 6px; font-weight: 800; color: #53bdeb; background: #121b22; padding: 14px 20px; border-radius: 12px; margin: 16px 0; }
        img { border-radius: 12px; background: #fff; padding: 12px; margin-top: 12px; }
        .btn { display: inline-block; margin-top: 12px; padding: 10px 18px; border-radius: 10px; background: #00a884; color: #fff; text-decoration: none; font-weight: 700; font-size: 13px; border: none; cursor: pointer; }
        .btn-reset { background: #ef4444; margin-left: 8px; }
        input { padding: 10px 12px; border-radius: 10px; border: 1px solid #334155; background: #121b22; color: #fff; width: 70%; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="badge">Status: ${connectionState.toUpperCase()} (Mode: ${authMode.toUpperCase()})</div>
        <h2>QuotLy Bhai WhatsApp Bot</h2>
        <p>Connected Backend: <code>${BACKEND_URL}</code></p>
        ${authMode === 'pair' && latestPairingCode && connectionState !== 'open' ? `<p>Enter this Pairing Code in WhatsApp &rarr; Linked Devices:</p><div class="code">${latestPairingCode}</div>` : ''}
        ${authMode === 'qr' && latestQrDataUrl && connectionState !== 'open' ? `<p>Scan this Fresh WhatsApp QR Code (Links in 3 sec):</p><img src="${latestQrDataUrl}" width="250" height="250" />` : ''}
        ${connectionState !== 'open' ? `
          <form action="/pair" method="GET" style="margin-top:16px;">
            <input type="text" name="phone" value="${PAIRING_NUMBER}" placeholder="919341384908" />
            <br/>
            <button type="submit" class="btn">Switch to 8-Digit Pairing Code</button>
            <a href="/reset-qr" class="btn btn-reset">Reset & Fresh QR</a>
          </form>
        ` : ''}
        ${connectionState === 'open' ? '<p style="color:#22c55e;font-weight:700;">WhatsApp Bot is Online & Ready for /q commands!</p><a href="/reset-qr" class="btn btn-reset">Logout & Reset Session</a>' : ''}
      </div>
    </body>
  </html>`)
})

app.get('/pair', async (req, res) => {
  const phone = String(req.query.phone || PAIRING_NUMBER || '').replace(/[^0-9]/g, '')
  if (phone) PAIRING_NUMBER = phone
  authMode = 'pair'
  latestQrDataUrl = null
  latestPairingCode = 'GENERATING...'
  destroyActiveSocket()
  clearAuthFolder()
  scheduleReconnect(600)
  res.redirect('/')
})

app.get('/reset-qr', (_req, res) => {
  authMode = 'qr'
  latestPairingCode = null
  latestQrDataUrl = null
  destroyActiveSocket()
  clearAuthFolder()
  scheduleReconnect(600)
  res.redirect('/')
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: connectionState, backend: BACKEND_URL })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Heroku web server listening on port ${PORT}`)
})

async function startBot() {
  destroyActiveSocket()
  const mySocketId = ++currentSocketId
  const logger = pino({ level: 'silent' })
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 10000,
    getMessage: async () => ({ conversation: 'QuotLy Bhai Bot' }),
  })
  activeSock = sock

  if (authMode === 'pair' && PAIRING_NUMBER && !sock.authState.creds.registered) {
    setTimeout(async () => {
      if (mySocketId !== currentSocketId) return
      try {
        const code = await sock.requestPairingCode(PAIRING_NUMBER)
        latestPairingCode = code?.match(/.{1,4}/g)?.join('-') || code
        console.log('====================================================')
        console.log('WHATSAPP PAIRING CODE:', latestPairingCode)
        console.log('====================================================')
      } catch (err) {
        console.error('Failed to request pairing code:', err.message)
      }
    }, 3500)
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      upsertContactInfo(c.id, c)
    }
  })

  sock.ev.on('contacts.update', (updates) => {
    for (const c of updates) {
      upsertContactInfo(c.id, c)
    }
  })

  sock.ev.on('messaging-history.set', ({ contacts }) => {
    if (Array.isArray(contacts)) {
      for (const c of contacts) {
        upsertContactInfo(c.id, c)
      }
    }
  })

  sock.ev.on('connection.update', async (update) => {
    if (mySocketId !== currentSocketId) return
    const { connection, lastDisconnect, qr } = update
    if (qr && authMode === 'qr') {
      connectionState = 'awaiting_qr_scan'
      latestQrDataUrl = await QRCode.toDataURL(qr)
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      console.log('[Connection Closed] statusCode:', statusCode)
      connectionState = 'reconnecting'
      if (
        statusCode === DisconnectReason.loggedOut ||
        statusCode === DisconnectReason.badSession ||
        statusCode === 401 ||
        statusCode === 405
      ) {
        clearAuthFolder()
        scheduleReconnect(2500)
      } else if (statusCode === 440 || statusCode === DisconnectReason.connectionReplaced) {
        console.log('[Connection] Replaced (440), waiting 6s before single reconnect...')
        scheduleReconnect(6000)
      } else {
        scheduleReconnect(2000)
      }
    } else if (connection === 'open') {
      connectionState = 'open'
      latestQrDataUrl = null
      latestPairingCode = null
      console.log('✅ WhatsApp Bot connected! Try replying /q to any message.')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (mySocketId !== currentSocketId) return
    if (type !== 'notify' && type !== 'append') return
    for (const msg of messages) {
      if (!msg?.message || !msg.key?.id) continue
      if (processedMsgIds.has(msg.key.id)) continue
      processedMsgIds.add(msg.key.id)
      if (processedMsgIds.size > 500) {
        const firstKey = processedMsgIds.values().next().value
        processedMsgIds.delete(firstKey)
      }

      const msgTimestamp = Number(msg.messageTimestamp || 0)
      if (msgTimestamp && Date.now() / 1000 - msgTimestamp > 45) continue

      const senderJid = msg.key.participant || msg.key.remoteJid
      if (msg.pushName && senderJid) {
        upsertContactInfo(senderJid, { notify: msg.pushName })
      }

      const jid = msg.key.remoteJid
      const mContent =
        msg.message.ephemeralMessage?.message ||
        msg.message.viewOnceMessage?.message ||
        msg.message.viewOnceMessageV2?.message ||
        msg.message

      const text =
        mContent?.conversation ||
        mContent?.extendedTextMessage?.text ||
        mContent?.imageMessage?.caption ||
        mContent?.videoMessage?.caption ||
        ''

      if (!text.trim().startsWith('/')) continue

      const [rawCmd, ...args] = text.trim().split(/\s+/)
      const cmd = rawCmd.toLowerCase()
      const argText = args.join(' ')
      const contextInfo =
        mContent?.extendedTextMessage?.contextInfo ||
        mContent?.imageMessage?.contextInfo ||
        mContent?.videoMessage?.contextInfo
      const rawQuotedMsg = contextInfo?.quotedMessage
      const quotedMsg =
        rawQuotedMsg?.ephemeralMessage?.message ||
        rawQuotedMsg?.viewOnceMessage?.message ||
        rawQuotedMsg
      const quotedParticipant = contextInfo?.participant || jid

    try {
      // 1. /q -> Quote message to 512x512 WebP Sticker
      if (cmd === '/q' || cmd === '/quote') {
        if (!quotedMsg) {
          await sock.sendMessage(
            jid,
            { text: 'Bhai kisi message par *reply* karke /q likho taaki uska sticker ban sake!' },
            { quoted: msg },
          )
          continue
        }

        const quotedText =
          quotedMsg.conversation ||
          quotedMsg.extendedTextMessage?.text ||
          quotedMsg.imageMessage?.caption ||
          quotedMsg.videoMessage?.caption ||
          'Media Message'

        const nestedContext = quotedMsg.extendedTextMessage?.contextInfo
        const nestedQuoted = nestedContext?.quotedMessage
        const nestedText =
          nestedQuoted?.conversation ||
          nestedQuoted?.extendedTextMessage?.text ||
          ''
        const nestedSender = nestedContext?.participant
          ? resolveBestDisplayName(nestedContext.participant, sock.user)
          : ''

        // If in a group and we don't have the participant's name yet, check groupMetadata once
        if (jid.endsWith('@g.us') && quotedParticipant) {
          try {
            const gMeta = await sock.groupMetadata(jid)
            for (const p of gMeta.participants || []) {
              if (p.id && (p.name || p.notify || p.verifiedName)) {
                upsertContactInfo(p.id, p)
              }
            }
          } catch {}
        }

        const senderName = resolveBestDisplayName(quotedParticipant, sock.user)
        const avatarDataUrl = await fetchAvatarDataUrl(sock, quotedParticipant)
        const phoneFallbackLabel = formatPhoneNumber(quotedParticipant)
        const themeArg = args[0]?.toLowerCase()
        const themeMap = {
          dark: 'whatsapp-dark',
          telegram: 'telegram-quotly',
          neon: 'neon-cyber',
          light: 'whatsapp-light',
        }
        const themeSlug = themeMap[themeArg] || DEFAULT_THEME

        const webpSticker = await createQuoteStickerWebp({
          backendUrl: BACKEND_URL,
          senderName,
          senderRole: senderName !== phoneFallbackLabel ? phoneFallbackLabel : (jid.endsWith('@g.us') ? 'Group Chat' : 'Direct Chat'),
          messageText: quotedText,
          repliedToName: nestedSender,
          repliedToText: nestedText,
          avatarDataUrl,
          themeSlug,
        })

        await sock.sendMessage(jid, { sticker: webpSticker }, { quoted: msg })
        continue
      }

      // 2. /s or /sticker -> Photo to Sticker
      if (cmd === '/s' || cmd === '/sticker') {
        const targetMessage = quotedMsg ? { message: quotedMsg } : { message: mContent }
        if (!targetMessage.message?.imageMessage) {
          await sock.sendMessage(
            jid,
            { text: 'Kisi photo par reply karke /s likho ya photo ke caption mein /s bhejo!' },
            { quoted: msg },
          )
          continue
        }
        const mediaBuffer = await downloadMediaMessage(targetMessage, 'buffer', {})
        const webp = await sharp(mediaBuffer)
          .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 90 })
          .toBuffer()
        await sock.sendMessage(jid, { sticker: webp }, { quoted: msg })
        continue
      }

      // 3. /toimg -> Sticker to PNG Image
      if (cmd === '/toimg') {
        if (!quotedMsg?.stickerMessage) {
          await sock.sendMessage(
            jid,
            { text: 'Kisi sticker par reply karke /toimg likho!' },
            { quoted: msg },
          )
          continue
        }
        const stickerBuffer = await downloadMediaMessage({ message: quotedMsg }, 'buffer', {})
        const pngBuffer = await sharp(stickerBuffer).png().toBuffer()
        await sock.sendMessage(
          jid,
          { image: pngBuffer, caption: 'Converted to HD PNG by QuotLy Bot' },
          { quoted: msg },
        )
        continue
      }

      // 4. /tagall -> Mention everyone in group
      if (cmd === '/tagall') {
        if (!jid.endsWith('@g.us')) {
          await sock.sendMessage(jid, { text: '/tagall sirf WhatsApp Groups mein kaam karta hai!' }, { quoted: msg })
          continue
        }
        const groupMeta = await sock.groupMetadata(jid)
        const mentions = groupMeta.participants.map((p) => p.id)
        const listText = mentions.map((id, idx) => `${idx + 1}. @${id.split('@')[0]}`).join('\n')
        await sock.sendMessage(
          jid,
          {
            text: `*${argText || 'Group Attention!'}*\n\n${listText}`,
            mentions,
          },
          { quoted: msg },
        )
        continue
      }

      // 5. /ai or /modi -> MODI CHATBOT (Modi Ji Tone Reply)
      if (cmd === '/ai' || cmd === '/modi' || cmd === '/ask') {
        const qText =
          quotedMsg?.conversation ||
          quotedMsg?.extendedTextMessage?.text ||
          quotedMsg?.imageMessage?.caption ||
          ''
        if (!argText && !qText) {
          await sock.sendMessage(
            jid,
            { text: 'Mitron! /ai ya /modi ke aage apna sawal likho, ya kisi message par reply karke /ai bhejo!' },
            { quoted: msg },
          )
          continue
        }
        const aiAnswer = await generateGeminiReply({ prompt: argText, quotedText: qText, mode: 'ai' })
        await sock.sendMessage(jid, { text: `*MODI CHATBOT:*\n\n${aiAnswer}` }, { quoted: msg })
        continue
      }

      // 6. /roast -> Friendly Hinglish Roast on Quoted Message
      if (cmd === '/roast') {
        const qText =
          quotedMsg?.conversation ||
          quotedMsg?.extendedTextMessage?.text ||
          argText
        if (!qText) {
          await sock.sendMessage(
            jid,
            { text: 'Kisi dost ke message par reply karke /roast likho!' },
            { quoted: msg },
          )
          continue
        }
        const roastLine = await generateGeminiReply({ prompt: argText, quotedText: qText, mode: 'roast' })
        await sock.sendMessage(jid, { text: `*MODI CHATBOT:*\n\n${roastLine}` }, { quoted: msg })
        continue
      }

      // 7. /qai -> Generate AI Quote & Send as 512x512 Sticker!
      if (cmd === '/qai') {
        const qText =
          quotedMsg?.conversation ||
          quotedMsg?.extendedTextMessage?.text ||
          ''
        const aiQuote = await generateGeminiReply({
          prompt: argText || 'Ek funny backbencher ya coding quote likho',
          quotedText: qText,
          mode: 'qai',
        })
        const targetJid = quotedParticipant || senderJid
        const senderName = resolveBestDisplayName(targetJid, sock.user)
        const avatarDataUrl = await fetchAvatarDataUrl(sock, targetJid)
        const webpSticker = await createQuoteStickerWebp({
          backendUrl: BACKEND_URL,
          senderName,
          senderRole: 'MODI CHATBOT',
          messageText: aiQuote,
          avatarDataUrl,
          themeSlug: DEFAULT_THEME,
        })
        await sock.sendMessage(jid, { sticker: webpSticker }, { quoted: msg })
        continue
      }

      // 5. /help -> List all commands from Backend
      if (cmd === '/help' || cmd === '/menu') {
        await sock.sendMessage(
          jid,
          {
            text:
              '*MODI CHATBOT — WhatsApp Commands*\n\n' +
              '• */q* — Kisi bhi msg par reply karke sticker banao (/q, /q neon, /q telegram, /q light)\n' +
              '• */ai <sawal>* (ya */modi*) — MODI CHATBOT se Modi ji ke tone mein jawab lo\n' +
              '• */roast* — Kisi msg par reply karke Modi ji style roast\n' +
              '• */qai <topic>* — AI se quote likhwa kar seedha sticker banao\n' +
              '• */s* — Photo ko 512x512 sticker banao\n' +
              '• */meme top | bottom* — Meme sticker banao\n' +
              '• */toimg* — Sticker ko wapas photo banao\n' +
              '• */tagall* — Group mein sabko mention karo',
          },
          { quoted: msg },
        )
      }
    } catch (err) {
      console.error('Command error:', err)
    }
    }
  })
}

startBot()
