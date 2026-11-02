import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import express from 'express'
import pino from 'pino'
import QRCode from 'qrcode'
import sharp from 'sharp'
import { createQuoteStickerWebp } from './src/quoteSticker.js'

const PORT = process.env.PORT || 8080
const BACKEND_URL = process.env.BOT_BACKEND_URL || 'https://ta-01m6da85d51j1wk6fge1gmby0v-1380-yffpduldc7jqjk00cb80baym5.makeproxy-m.figma.site'
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || '').replace(/[^0-9]/g, '')
const DEFAULT_THEME = process.env.DEFAULT_QUOTE_THEME || 'whatsapp-dark'

let latestQrDataUrl = null
let latestPairingCode = null
let connectionState = 'initializing'

const app = express()

app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>QuotLy Bhai WhatsApp Bot - Heroku Status</title>
      <meta http-equiv="refresh" content="6" />
      <style>
        body { font-family: system-ui, sans-serif; background: #0b141a; color: #e9edef; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .card { background: #1f2c34; padding: 32px; border-radius: 20px; max-width: 440px; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
        .badge { display: inline-block; padding: 6px 14px; border-radius: 999px; background: #00a884; color: #fff; font-weight: 700; font-size: 13px; margin-bottom: 16px; }
        .code { font-size: 28px; letter-spacing: 6px; font-weight: 800; color: #53bdeb; background: #121b22; padding: 14px 20px; border-radius: 12px; margin: 16px 0; }
        img { border-radius: 12px; background: #fff; padding: 12px; margin-top: 12px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="badge">Status: ${connectionState.toUpperCase()}</div>
        <h2>QuotLy Bhai WhatsApp Bot</h2>
        <p>Connected Backend: <code>${BACKEND_URL}</code></p>
        ${latestPairingCode ? `<p>Enter this Pairing Code in WhatsApp &rarr; Linked Devices:</p><div class="code">${latestPairingCode}</div>` : ''}
        ${latestQrDataUrl && connectionState !== 'open' ? `<p>Or scan this WhatsApp QR Code:</p><img src="${latestQrDataUrl}" width="240" height="240" />` : ''}
        ${connectionState === 'open' ? '<p style="color:#22c55e;font-weight:700;">WhatsApp Bot is Online & Ready for /q commands!</p>' : ''}
      </div>
    </body>
  </html>`)
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: connectionState, backend: BACKEND_URL })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Heroku web server listening on port ${PORT}`)
})

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: !PAIRING_NUMBER,
    auth: state,
    browser: ['QuotLy Bhai Bot', 'Chrome', '120.0.0'],
  })

  if (PAIRING_NUMBER && !sock.authState.creds.registered) {
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
    }, 3000)
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      connectionState = 'awaiting_qr_scan'
      latestQrDataUrl = await QRCode.toDataURL(qr)
    }
    if (connection === 'close') {
      connectionState = 'reconnecting'
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) {
        setTimeout(startBot, 4000)
      }
    } else if (connection === 'open') {
      connectionState = 'open'
      latestQrDataUrl = null
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
