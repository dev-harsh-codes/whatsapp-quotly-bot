import sharp from 'sharp'

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export async function createQuoteStickerWebp({
  backendUrl,
  senderName,
  senderRole,
  messageText,
  repliedToName,
  repliedToText,
  themeSlug = 'whatsapp-dark',
}) {
  // 1. First try the connected Payload + Sharp Backend API (logs sticker & uses CMS theme)
  if (backendUrl) {
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

  // 2. Local Sharp SVG fallback so /q works even offline
  const safeSender = escapeXml(senderName || 'WhatsApp User')
  const safeText = escapeXml((messageText || '').slice(0, 180))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect x="64" y="160" width="416" height="190" rx="22" fill="#1f2c34" />
    <circle cx="32" cy="196" r="24" fill="#00a884" />
    <text x="88" y="198" fill="#00a884" font-family="sans-serif" font-size="20" font-weight="bold">${safeSender}</text>
    <text x="88" y="244" fill="#e9edef" font-family="sans-serif" font-size="22">${safeText}</text>
  </svg>`

  return sharp(Buffer.from(svg))
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 92 })
    .toBuffer()
}
