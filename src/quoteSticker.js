import sharp from 'sharp'

const THEMES = {
  'whatsapp-dark': {
    bubbleBg: '#1f2c34',
    textColor: '#e9edef',
    nameColor: '#00a884',
    replyBg: '#121b22',
    accentColor: '#53bdeb',
  },
  'telegram-quotly': {
    bubbleBg: '#182533',
    textColor: '#f5f5f5',
    nameColor: '#64b5ef',
    replyBg: '#101923',
    accentColor: '#38bdf8',
  },
  'neon-cyber': {
    bubbleBg: '#1a1033',
    textColor: '#f3e8ff',
    nameColor: '#c084fc',
    replyBg: '#110924',
    accentColor: '#22d3ee',
  },
  'whatsapp-light': {
    bubbleBg: '#ffffff',
    textColor: '#111b21',
    nameColor: '#008069',
    replyBg: '#f0f2f5',
    accentColor: '#0284c7',
  },
}

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function wrapTextLines(text, maxCharsPerLine, maxLines) {
  const words = String(text || '').trim().split(/\s+/)
  const lines = []
  let currentLine = ''
  for (const word of words) {
    if (!currentLine) {
      currentLine = word
    } else if ((currentLine + ' ' + word).length <= maxCharsPerLine) {
      currentLine += ' ' + word
    } else {
      lines.push(currentLine)
      currentLine = word
      if (lines.length >= maxLines - 1) break
    }
  }
  if (currentLine && lines.length < maxLines) lines.push(currentLine)
  return lines.length > 0 ? lines : ['...']
}

function getInitials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'WA'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export async function createQuoteStickerWebp({
  backendUrl,
  senderName,
  senderRole,
  messageText,
  repliedToName,
  repliedToText,
  avatarDataUrl,
  themeSlug = 'whatsapp-dark',
}) {
  // 1. First try the connected Payload + Sharp Backend API (logs sticker & uses CMS theme)
  if (backendUrl && !backendUrl.includes('localhost')) {
    try {
      const res = await fetch(`${backendUrl.replace(/\/$/, '')}/api/quote-sticker?format=webp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderName,
          senderRole,
          messageText,
          repliedToName,
          repliedToText,
          avatarDataUrl,
          themeSlug,
          source: 'heroku-bot',
        }),
      })
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer()
        return Buffer.from(arrayBuf)
      }
    } catch (err) {
      console.warn('Backend /api/quote-sticker unreachable, using local Sharp fallback:', err.message)
    }
  }

  // 2. Full HD 512x512 Local Sharp SVG Renderer (works standalone on Heroku)
  const theme = THEMES[themeSlug] || THEMES['whatsapp-dark']
  const safeSender = escapeXml((senderName || 'WhatsApp User').slice(0, 32))
  const safeRole = escapeXml((senderRole || '').slice(0, 24))
  const rawMsg = String(messageText || 'Quoted message').slice(0, 280)
  const hasReply = Boolean(repliedToName || repliedToText)
  const safeAvatar =
    avatarDataUrl && String(avatarDataUrl).startsWith('data:image/')
      ? escapeXml(String(avatarDataUrl))
      : ''

  const fontSize = rawMsg.length < 45 ? 24 : rawMsg.length < 110 ? 20 : 17
  const lineHeight = Math.round(fontSize * 1.38)
  const maxChars = fontSize === 24 ? 26 : fontSize === 20 ? 32 : 37
  const lines = wrapTextLines(rawMsg, maxChars, 6)

  const replyBlockHeight = hasReply ? 64 : 0
  const textBlockHeight = lines.length * lineHeight
  const bubbleHeight = Math.max(128, 56 + replyBlockHeight + textBlockHeight + 34)
  const bubbleY = Math.round((512 - bubbleHeight) / 2)
  const bubbleX = 88
  const bubbleWidth = 404
  const replyStartY = bubbleY + 48
  const textStartY = bubbleY + 52 + (hasReply ? replyBlockHeight + 12 : 10)
  const initials = escapeXml(getInitials(senderName))
  const nowTime = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

  const tspans = lines
    .map((line, i) => `<text x="${bubbleX + 20}" y="${textStartY + i * lineHeight}" fill="${theme.textColor}" font-family="sans-serif" font-size="${fontSize}">${escapeXml(line)}</text>`)
    .join('\n')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <defs>
      <clipPath id="dpClip">
        <circle cx="44" cy="${bubbleY + 32}" r="28" />
      </clipPath>
    </defs>
    <circle cx="44" cy="${bubbleY + 32}" r="28" fill="${theme.nameColor}" />
    <text x="44" y="${bubbleY + 39}" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="20" font-weight="bold">${initials}</text>
    ${safeAvatar ? `<image href="${safeAvatar}" x="16" y="${bubbleY + 4}" width="56" height="56" preserveAspectRatio="xMidYMid slice" clip-path="url(#dpClip)" />` : ''}
    <circle cx="64" cy="${bubbleY + 52}" r="7" fill="#22c55e" stroke="${theme.bubbleBg}" stroke-width="2.5" />
    <path d="M ${bubbleX - 12} ${bubbleY + 18} L ${bubbleX + 4} ${bubbleY + 18} L ${bubbleX + 4} ${bubbleY + 36} Z" fill="${theme.bubbleBg}" />
    <rect x="${bubbleX}" y="${bubbleY}" width="${bubbleWidth}" height="${bubbleHeight}" rx="22" ry="22" fill="${theme.bubbleBg}" />
    <text x="${bubbleX + 20}" y="${bubbleY + 32}" fill="${theme.nameColor}" font-family="sans-serif" font-size="18" font-weight="bold">${safeSender}</text>
    ${safeRole ? `<text x="${bubbleX + bubbleWidth - 18}" y="${bubbleY + 31}" text-anchor="end" fill="${theme.accentColor}" font-family="sans-serif" font-size="12">${safeRole}</text>` : ''}
    ${hasReply ? `
      <rect x="${bubbleX + 16}" y="${replyStartY}" width="${bubbleWidth - 32}" height="54" rx="10" fill="${theme.replyBg}" />
      <rect x="${bubbleX + 16}" y="${replyStartY}" width="5" height="54" rx="2.5" fill="${theme.accentColor}" />
      <text x="${bubbleX + 30}" y="${replyStartY + 21}" fill="${theme.accentColor}" font-family="sans-serif" font-size="13" font-weight="bold">${escapeXml((repliedToName || 'Reply').slice(0, 28))}</text>
      <text x="${bubbleX + 30}" y="${replyStartY + 41}" fill="${theme.textColor}" opacity="0.8" font-family="sans-serif" font-size="13">${escapeXml((repliedToText || '').slice(0, 40))}</text>
    ` : ''}
    ${tspans}
    <text x="${bubbleX + bubbleWidth - 22}" y="${bubbleY + bubbleHeight - 12}" text-anchor="end" fill="${theme.textColor}" opacity="0.6" font-family="sans-serif" font-size="11.5">${escapeXml(nowTime)}</text>
  </svg>`

  return sharp(Buffer.from(svg))
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 92 })
    .toBuffer()
}
