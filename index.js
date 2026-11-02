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
const AUTH_DIR = './auth_info_baileys'

let latestQrDataUrl = null
let latestPairingCode = null
let connectionState = 'initializing'
let activeSock = null
let authMode = 'qr' // 'qr' or 'pair' — never run both on the same socket!

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
  clearAuthFolder()
  try {
    activeSock?.end(undefined)
  } catch {}
  setTimeout(() => startBot(), 500)
  res.redirect('/')
})

app.get('/reset-qr', (_req, res) => {
  authMode = 'qr'
  latestPairingCode = null
  latestQrDataUrl = null
  clearAuthFolder()
  try {
    activeSock?.end(undefined)
  } catch {}
  setTimeout(() => startBot(), 500)
  res.redirect('/')
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: connectionState, backend: BACKEND_URL })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Heroku web server listening on port ${PORT}`)
})

async function startBot() {
  const logger = pino({ level: 'silent' })
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: authMode === 'qr',
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

  sock.ev.on('connection.update', async (update) => {
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
        setTimeout(startBot, 2000)
      } else {
        setTimeout(startBot, 1500)
      }
    } else if (connection === 'open') {
      connectionState = 'open'
      latestQrDataUrl = null
      latestPairingCode = null
      console.log('✅ WhatsApp Bot connected! Try replying /q to any message.')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg?.message) return

    const jid = msg.key.remoteJid
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      ''

    if (!text.startsWith('/')) return

    const [rawCmd, ...args] = text.trim().split(/\s+/)
    const cmd = rawCmd.toLowerCase()
    const argText = args.join(' ')
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo
    const quotedMsg = contextInfo?.quotedMessage
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
          return
        }

        const quotedText =
          quotedMsg.conversation ||
          quotedMsg.extendedTextMessage?.text ||
          quotedMsg.imageMessage?.caption ||
          'Media Message'

        const senderPhone = quotedParticipant ? quotedParticipant.split('@')[0] : 'Friend'
        const senderName = msg.pushName && msg.key.fromMe ? msg.pushName : `~${senderPhone}`
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
          senderRole: jid.endsWith('@g.us') ? 'Group Chat' : 'Direct Chat',
          messageText: quotedText,
          themeSlug,
        })

        await sock.sendMessage(jid, { sticker: webpSticker }, { quoted: msg })
        return
      }

      // 2. /s or /sticker -> Photo to Sticker
      if (cmd === '/s' || cmd === '/sticker') {
        const targetMessage = quotedMsg ? { message: quotedMsg } : msg
        if (!targetMessage.message?.imageMessage) {
          await sock.sendMessage(
            jid,
            { text: 'Kisi photo par reply karke /s likho ya photo ke caption mein /s bhejo!' },
            { quoted: msg },
          )
          return
        }
        const mediaBuffer = await downloadMediaMessage(targetMessage, 'buffer', {})
        const webp = await sharp(mediaBuffer)
          .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 90 })
          .toBuffer()
        await sock.sendMessage(jid, { sticker: webp }, { quoted: msg })
        return
      }

      // 3. /toimg -> Sticker to PNG Image
      if (cmd === '/toimg') {
        if (!quotedMsg?.stickerMessage) {
          await sock.sendMessage(
            jid,
            { text: 'Kisi sticker par reply karke /toimg likho!' },
            { quoted: msg },
          )
          return
        }
        const stickerBuffer = await downloadMediaMessage({ message: quotedMsg }, 'buffer', {})
        const pngBuffer = await sharp(stickerBuffer).png().toBuffer()
        await sock.sendMessage(
          jid,
          { image: pngBuffer, caption: 'Converted to HD PNG by QuotLy Bot' },
          { quoted: msg },
        )
        return
      }

      // 4. /tagall -> Mention everyone in group
      if (cmd === '/tagall') {
        if (!jid.endsWith('@g.us')) {
          await sock.sendMessage(jid, { text: '/tagall sirf WhatsApp Groups mein kaam karta hai!' }, { quoted: msg })
          return
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
        return
      }

      // 5. /help -> List all commands from Backend
      if (cmd === '/help' || cmd === '/menu') {
        await sock.sendMessage(
          jid,
          {
            text:
              '*QuotLy Bhai WhatsApp Bot Commands*\n\n' +
              '• */q* — Kisi bhi msg par reply karke sticker banao (/q, /q neon, /q telegram, /q light)\n' +
              '• */s* — Photo ko 512x512 sticker banao\n' +
              '• */meme top | bottom* — Meme sticker banao\n' +
              '• */toimg* — Sticker ko wapas photo banao\n' +
              '• */tagall* — Group mein sabko mention karo\n' +
              '• */ai <sawal>* — Smart AI reply',
          },
          { quoted: msg },
        )
      }
    } catch (err) {
      console.error('Command error:', err)
    }
  })
}

startBot()
