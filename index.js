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
const BACKEND_URL = process.env.BOT_BACKEND_URL || 'https://app-bclfvhxxejkooh6yxxca2zbxsxwuqwganispe2yc5tcb52wfwwha.makeproxy-c.figma.site'
let PAIRING_NUMBER = (process.env.PAIRING_NUMBER || '').replace(/[^0-9]/g, '')
const DEFAULT_THEME = process.env.DEFAULT_QUOTE_THEME || 'whatsapp-dark'
const AUTH_DIR = './auth_info_baileys'

// Collect up to 5+ Gemini API keys (supports GEMINI_API_KEY_1..5 OR comma-separated GEMINI_API_KEY)
const GEMINI_KEYS = Array.from(
  new Set(
    [
      process.env.GEMINI_API_KEY,
      process.env.GEMINI_API_KEY_1,
      process.env.GEMINI_API_KEY_2,
      process.env.GEMINI_API_KEY_3,
      process.env.GEMINI_API_KEY_4,
      process.env.GEMINI_API_KEY_5,
      process.env.APP_GEMINI_API_KEY,
    ]
      .filter(Boolean)
      .flatMap((v) => String(v).split(/[,;\s]+/))
      .map((k) => k.trim())
      .filter(Boolean),
  ),
)
let keyRotationIndex = 0

function wantsDetailedAnswer(text = '') {
  return /(explain|detail|acha se|ache se|achha se|elaborate|step by step|pura bata|lamba|vistar|code)/i.test(
    String(text),
  )
}

let latestQrDataUrl = null
let latestPairingCode = null
let connectionState = 'initializing'
let activeSock = null
let currentSocketId = 0
let reconnectTimer = null
let authMode = 'qr' // 'qr' or 'pair' — never run both on the same socket!
const contactDirectory = new Map() // jid -> { name, notify, verifiedName }
const processedMsgIds = new Set()

const CAMPUS_LORE = "IIIT Bhagalpur — Mechatronics (MAE) 1st Year Batch Context:\n- Group Name: \"Mechatronics Student Group\" (pehle \"मेकाट्रॉनिक्स छात्र समूह\" aur \"मेकाट्रॉनिकी-छात्रसमूहः\" rakha gaya tha).\n- Professors Lore:\n  * PKT Sir (Purnendu Sir): Sabse khatarnak prof, mass bunk karne par extra class lagate hain aur campus ke bahar ghumte hue bacho ko pakad lete hain.\n  * Nehal Sir: CS101 (C Programming) padhate hain, 1 ghante mein bas 2 doubtful question karate hain.\n  * Raunak Sir: Maths (Vector Space & Matrices) padhate hain, har baat pe bolte hain \"HOD se baat karna padega\".\n  * Rajan Sir: Engineering Graphics / SolidWorks padhate hain (sirf scale banana sikhaya).\n  * Anita Chandra Ma'am: Mid-sem paper banati hain.\n- Batch Culture: Har hafte Mass Bunk ke liye 10 polls bante hain (4 se 18 chutti), phir bhi 2-4 gaddar class chale jaate hain. CR ki kursi ke liye roz drama aur resignation chalta hai."
const STUDENT_KUNDALIS = [
  {
    "id": "shaurya-malik",
    "name": "Shaurya Malik",
    "aliases": [
      "shaurya malik",
      "malik",
      "siyar",
      "boys cr"
    ],
    "phones": [],
    "title": "Boys CR & Serial Resigner (1549+ msgs)",
    "kundali": "Group creator aur Boys CR. Har hafte \"Respected sir, I have left the position of CR\" bolke resign karta hai aur wapas CR ban jata hai. SolidWorks aur Rajan sir ke assignments forward karta hai. Mass bunk polls banata hai par Harsh kehta hai ye chhup ke sab padh ke baitha hai. 108 vs 10.8 marks wala legend."
  },
  {
    "id": "harsh-shourya",
    "name": "Harsh / Shourya Narayan",
    "aliases": [
      "harsh",
      "shourya",
      "shourya narayan",
      "𝐇𝐀𝐑𝐒𝐇"
    ],
    "phones": [
      "919341384908"
    ],
    "title": "Bot Mastermind, 15 Fake IDs & Poll King (1650+ msgs)",
    "kundali": "MODI CHATBOT ka malik aur creator. 15 virtual IDs se polls aur classes join karta hai. Khud ko \"Green Flag\" aur apni biwi ko bhi green flag batata hai. Shaurya Malik ko \"CR ki kursi leke jao\" aur \"gaddar CR sab padh ke baitha hai\" bolke roast karta hai. Sabko Google One 5TB aur Gemini Pro baant-ta hai."
  },
  {
    "id": "anshika",
    "name": "Anshika Singh (Maharani CR)",
    "aliases": [
      "anshika",
      "maharani",
      "pradesh ki maharani",
      "iiit mechantronics pradesh ki maharani"
    ],
    "phones": [],
    "title": "Mechatronics Pradesh Ki Maharani & Girl CR (764+ msgs)",
    "kundali": "Batch ki Girl CR (\"IIIT Mechatronics Pradesh Ki Maharani\"). Maam aur PKT sir se baat karke classes cancel/reschedule karwati hai. Har message mein 🥀 aur 😭 lagati hai (\"Dekh lenge hume bhagte hue fir pitenge hum 🥀\"). Kabhi group settings \"Only Admins\" karti hai jab shor badh jata hai."
  },
  {
    "id": "shivam",
    "name": "Shivam Bhai",
    "aliases": [
      "shivam",
      "shivam bhai"
    ],
    "phones": [],
    "title": "Protest Leader & Party Mangne Wala (704+ msgs)",
    "kundali": "Har baat pe \"PROTEST karna padega\" aur CRs se party mangta hai (\"When MNC CR was appointed, he gave party\", \"Laban Kumar aura farmers party date and venue\"). Catchphrases: \"Hey Prabhu kaha the aap\", \"screenshot naamak feature ka use kare\", aur Shaurya Malik ko \"lal dil gulabi dil 💋\" bhejta hai."
  },
  {
    "id": "avii",
    "name": "Avii",
    "aliases": [
      "avii",
      "8292643029"
    ],
    "phones": [
      "918292643029"
    ],
    "title": "Aura Emperor (\"I am Aura\") (369+ msgs)",
    "kundali": "Famous dialogue: \"Skyler I dont need aura, I am aura\". Hostel mein hi rehta hai, ghar nahi jata (\"mai toh ghar bhi nhi jaa rha, full support to masses\"). Kehta hai \"CSEtards taking notes from us\" aur \"कोटि कोटि नमन humare batch ko\"."
  },
  {
    "id": "satyam-chandel",
    "name": "Satyam Raj (Satyam Chandel)",
    "aliases": [
      "satyam",
      "chandel",
      "aurangabad",
      "satyam raj"
    ],
    "phones": [],
    "title": "Aurangabad Philosopher & AC Train Traveller (287+ msgs)",
    "kundali": "Aurangabad (Gaya ke aage) se hai. General ya sleeper mein nahi jata (\"TT aata hai yrr\"). Bade-bade philosophical aur savage taunts marta hai (\"Musketeers of truth veiled in lies\", \"3 LPA ka reference kaise milega jute chaat ke\", \"makhanchor\"). Notification history hamesha ON rakhta hai taaki deleted messages pakad sake."
  },
  {
    "id": "saksham",
    "name": "Saksham (Roll 233)",
    "aliases": [
      "saksham",
      "233"
    ],
    "phones": [],
    "title": "Ranked Match Gamer & Coder (276+ msgs)",
    "kundali": "C programming ke codes khud banata hai par classes se sakt nafrat hai: \"Top pe tho mai hu muje kisi bhi class mai interest nahi hai\" aur \"Bhaad mai jaaye, mai nahi jaa raha, waise bhi ranked match mai hu\". Group ka pehla rule isi ne likha tha ki kisi prof ya senior ko mat add karna."
  },
  {
    "id": "soumanka",
    "name": "Soumanka",
    "aliases": [
      "soumanka",
      "8910128058"
    ],
    "phones": [
      "918910128058"
    ],
    "title": "Kurkure Daan & Chicken Hartal Legend (231+ msgs)",
    "kundali": "Har baat mein \"Malik\" bolta hai (\"Udhari ki zindagi hai malik\", \"Explore ke naam pe bas Windows browser chalaya hu malik\"). Anshika se kehta hai \"10-20 rupay daan me dena Kurkure khaunga\". Famous lines: \"Mai chicken khake hartal karunga\", \"Shaurya ko BTech Chaiwala banao\", aur \"Jamming session on Trunkut\"."
  },
  {
    "id": "laban",
    "name": "Laban Kumar",
    "aliases": [
      "laban",
      "9608510910"
    ],
    "phones": [
      "919608510910"
    ],
    "title": "New CR & Mass Bunk Coordinator (229+ msgs)",
    "kundali": "Baad mein CR / coordinator bana (\"Don't rush, I will inform you mass bunk date\", \"Everyone come in 202\"). Raunak sir ke Vector Space & Matrices ke notes bhejta hai aur C programming mein sabki madad karta hai. Shivam isse \"Aura Farmers Party\" mangta rehta hai."
  },
  {
    "id": "dhruv",
    "name": "Dhruv",
    "aliases": [
      "dhruv"
    ],
    "phones": [],
    "title": "Guard Bhaiya Alumni Joke & Rajgrahan King (185+ msgs)",
    "kundali": "Deadpan sarcasm king: \"Maine bahar guard bhaiya se poocha tha wo IIIT Mechatronics ke alumni nikle\" aur \"Aaj subah 6 baje se raat ke 9:45 tak classes hai\". Khud ke \"Rajgrahan\" ke liye Tameshwar sir ko DM karwata hai."
  },
  {
    "id": "parth-patel",
    "name": "Parth Patel",
    "aliases": [
      "parth",
      "patel"
    ],
    "phones": [],
    "title": "Chhata Chor Victim & Shayari King (158+ msgs)",
    "kundali": "CS class ke 2nd bench se iska eklauta chhata (umbrella) chori ho gaya tha (\"Ek hi chata laya hu 🥲\"). CR par shayari marta hai: \"Jo na bana kisi ka saiyan wohi hai humare CR bhaiya\". Dandiya nights ke pass dhoondhta rehta hai."
  },
  {
    "id": "shubham-jhunjhun",
    "name": "Shubham (Jhunjhunu 139)",
    "aliases": [
      "jhunjhun",
      "139",
      "shubham jhunjhun"
    ],
    "phones": [],
    "title": "Self-Declared Student Representative (156+ msgs)",
    "kundali": "Khud ko \"Student Representative\" ghoshit kar chuka hai. Mass bunk ka sabse bada supporter (\"4 se 18 confirm hai koi poll nhi\"). Famous lines: \"Pikachu hum tumhe chunte hai\" aur \"Ek raat main paas hue hai bhai\"."
  },
  {
    "id": "sakshi",
    "name": "Sakshi",
    "aliases": [
      "sakshi",
      "sakshii"
    ],
    "phones": [],
    "title": "Mass Bunk Extender & \"Paper Khali Chhodenge\" Leader (134+ msgs)",
    "kundali": "Har message mein 🙃, 👉👈 aur 🤧 lagati hai. C programming aur lab cancel karwane ke liye hamesha ready (\"Okkiee kr do yr cancel ni jaana mujhe 😭\", \"hum paper khaali chorke aayenge\"). Chhath Puja aur Dussehra ki chutti sabse pehle puchti hai."
  },
  {
    "id": "adrish",
    "name": "Adrish (Room 310)",
    "aliases": [
      "adrish",
      "310"
    ],
    "phones": [],
    "title": "West Bengal Rep & Notes Hunter (104+ msgs)",
    "kundali": "West Bengal se hai, Hostel Room 310. Pehla hi dialogue: \"Bas CR absent tha\". Engineering Materials ke notes mangta rehta hai aur \"Fahhh\" bolta hai."
  },
  {
    "id": "shubham-karnataka",
    "name": "Shubham #10 (Karnataka / Kho-Kho Champion)",
    "aliases": [
      "karnataka",
      "kho kho",
      "number ten",
      "mechanonics"
    ],
    "phones": [],
    "title": "Karnataka Kho-Kho Champion & Washing Machine Philosopher (91+ msgs)",
    "kundali": "Karnataka se aaya hai, टूटी-फूटी pyari Hindi bolta hai, roommate Marathi hai. Kho-Kho Champion hai. Harsh se 5TB Google One aur Gemini Pro subscription liya hai. Famous dialogue: \"Bhai 18 log washing machine me nhi atenge\" aur \"#UnemploymentMachine\"."
  },
  {
    "id": "utkarsh-seth",
    "name": "Utkarsh Seth",
    "aliases": [
      "utkarsh",
      "seth"
    ],
    "phones": [],
    "title": "SIH Hustler & Group Reality Checker (81+ msgs)",
    "kundali": "Serious SIH aur team-building wala banda. Pure group ko ek line mein roast kiya tha: \"By watching messages of this group.. I found this group is mainly for Shaurya Malik & HARSH.. Rest see the drama\". Electrical lab ki file ke photos mangta rehta hai."
  },
  {
    "id": "karthik-reddy",
    "name": "Karthik Reddy",
    "aliases": [
      "karthik",
      "reddy"
    ],
    "phones": [],
    "title": "Quiz over Mid-Sem Strategist & Thala Fan (78+ msgs)",
    "kundali": "Adhyaay team member aur practical banda (\"It's better to write a quiz rather than mid sem\", \"C tho hi hai naki Relativity\", \"8-1=7 Thala for a Reason\")."
  },
  {
    "id": "chayan-rana",
    "name": "Chayan Rana",
    "aliases": [
      "chayan",
      "rana"
    ],
    "phones": [],
    "title": "Jagannath Puri Ghost & Savage One-Liner (67+ msgs)",
    "kundali": "Odisha (Jagannath Puri) se hai. Raat ko bolta hai \"Ma bhoot huu\", \"Who asked for your opinion\", \"Hasne ke liya tax dena padhta ha kya\"."
  },
  {
    "id": "arunika",
    "name": "Arunika",
    "aliases": [
      "arunika"
    ],
    "phones": [],
    "title": "CR Roaster & Hostel Lock Gang (62+ msgs)",
    "kundali": "Anshika ki dost. Khul ke bolti hai \"Areey CR ki yaha nhi chalti broo 😂😂\" aur \"tumhare aane se pehle hi hum lock kr chuke honge\"."
  },
  {
    "id": "reyansh",
    "name": "Reyansh Chandra",
    "aliases": [
      "reyansh",
      "9243177919"
    ],
    "phones": [
      "919243177919"
    ],
    "title": "Proxy Master (\"20 bacho me 40 ki proxy\") (56+ msgs)",
    "kundali": "Famous quote: \"Physically present but mentally kahi aur\" aur \"20 bacho me 40 ki proxy laga dete hai 💀\". Nehal sir ke C classes skip karne ka sabse bada supporter."
  },
  {
    "id": "sangeet",
    "name": "Sangeet",
    "aliases": [
      "sangeet"
    ],
    "phones": [],
    "title": "Lost Fastrack Watch & 7 Crore Package Taunter (36+ msgs)",
    "kundali": "Mechanical workshop mein apni Fastrack smartwatch bhool aaya tha. Jo bache bunk nahi marte unko bolta hai \"Mechatronics walo ko shayad 7 Cr ka package chahiye isliye itna ragad rahe hai\"."
  },
  {
    "id": "sayan-saha",
    "name": "Sayan Saha",
    "aliases": [
      "sayan",
      "9641616989"
    ],
    "phones": [
      "919641616989"
    ],
    "title": "Mass Bunk Enforcer (35+ msgs)",
    "kundali": "Seedhi dhamki deta hai: \"Tum akele jaoge tumhari attendance waise bhi nhi lagegi aur baki ka tum khud samajh lo ☠️\"."
  },
  {
    "id": "roll-34",
    "name": "Roll No. 34 (NCC & Basanti Dialogues)",
    "aliases": [
      "9098268514",
      "roll no 34",
      "roll 34"
    ],
    "phones": [
      "919098268514"
    ],
    "title": "Proxy Roll No. 34 & Basanti Dialogue King",
    "kundali": "Har class mein bolta hai \"Proxy laga dena meri roll no. 34\" aur \"In kutto ke samne mat nachna basanti\". Vote dene ke badle birthday party mangta hai."
  },
  {
    "id": "arpan",
    "name": "Arpan (Room 321)",
    "aliases": [
      "arpan",
      "8627953654"
    ],
    "phones": [
      "918627953654"
    ],
    "title": "Room 321 Bulk Order & Cash Collector",
    "kundali": "Batch ke saare bulk orders place karta hai aur kehta hai \"Jisne cash me payment krna hai vo room no. 321 me pakda do\"."
  }
]

// Pre-seed known phone numbers from IIIT Bhagalpur Mechatronics chat export
for (const stu of STUDENT_KUNDALIS) {
  for (const ph of stu.phones || []) {
    contactDirectory.set(`${ph}@s.whatsapp.net`, { name: stu.name, notify: stu.name, verifiedName: '' })
  }
}

function buildStudentKundaliContext(queryText = '', jid = '') {
  const cleanPhone = String(jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
  const lower = String(queryText || '').toLowerCase()
  const matched = STUDENT_KUNDALIS.filter((s) => {
    const pMatch = cleanPhone && (s.phones || []).some((p) => cleanPhone.endsWith(p.slice(-10)))
    const nMatch =
      (s.aliases || []).some((a) => lower.includes(a.toLowerCase())) ||
      lower.includes(s.name.toLowerCase())
    return pMatch || nMatch
  })
  if (matched.length > 0) {
    return (
      CAMPUS_LORE +
      '\n\nMatched Student Kundali:\n' +
      matched.map((m) => `- ${m.name} (${m.title}): ${m.kundali}`).join('\n')
    )
  }
  return (
    CAMPUS_LORE +
    '\n\nIIIT Bhagalpur Mechatronics Key Students:\n' +
    STUDENT_KUNDALIS.slice(0, 14)
      .map((m) => `- ${m.name} (${m.title}): ${m.kundali}`)
      .join('\n')
  )
}

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

async function generateGeminiReply({ prompt, quotedText = '', targetName = '', targetJid = '', mode = 'ai' }) {
  const kundaliContext = buildStudentKundaliContext(`${prompt} ${quotedText} ${targetName}`, targetJid)
  const isDetailed = wantsDetailedAnswer(`${prompt} ${quotedText}`) || mode === 'kundali'
  const lengthRule = isDetailed
    ? 'Modi ji ke tone mein 3-4 punchy lines mein mazedar jawab/kundali do.'
    : 'STRICT RULE: Jawab SIRF 2 se 3 short lines (maximum 35-45 words) mein hi dena! Bada paragraph bilkul mat likhna. Chhota, punchy aur witty 2-3 line mein baat khatam karo.'

  const systemInstruction =
    mode === 'roast'
      ? `Tum IIIT Bhagalpur Mechatronics batch ke official MODI CHATBOT ho ("Mitron!", "Mere pyare deshwasiyon"). Niche diye gaye batch context aur student kundali ka use karke Modi ji ke andaaz mein SIRF 2-3 short lines ka personal, savage aur funny roast likho.\n\n${kundaliContext}`
      : mode === 'kundali'
        ? `Tum IIIT Bhagalpur Mechatronics batch ke official MODI CHATBOT ho ("Mitron!", "Bhaiyon aur behno!"). Niche diye gaye student kundali data ke hisaab se is bachhe ki 3-4 lines mein Modi ji ke tone mein mazedar Kundali aur pol khol ke rakh do!\n\n${kundaliContext}`
      : mode === 'qai'
        ? `Tum MODI CHATBOT ho. Bilkul Modi ji ke iconic tone ("Mitron...", "Bhaiyon aur behno...") mein sirf 1 short punchy, funny Hinglish line (max 18 words) likho jo WhatsApp sticker par mast lage.\n\n${kundaliContext}`
        : `Tum IIIT Bhagalpur Mechatronics batch ke official MODI CHATBOT ho — tum hamesha Narendra Modi ji ke iconic speech tone ("Mitron!", "Mere pyare deshwasiyon!", "Bhaiyon aur behno!") mein Hinglish mein jawab dete ho aur batch ke har student ki aadat aur kundali jante ho! ${lengthRule}\n\n${kundaliContext}`

  const userPrompt = quotedText
    ? `Sender/Target: ${targetName || 'Student'}\nQuoted Message: "${quotedText}"\n\nUser Request: ${prompt || 'Reply to this'}`
    : prompt

  // 1. Round-Robin across all configured Gemini API keys (GEMINI_API_KEY_1..5 or comma-separated)
  if (GEMINI_KEYS.length > 0) {
    const startIdx = keyRotationIndex++ % GEMINI_KEYS.length
    for (let offset = 0; offset < GEMINI_KEYS.length; offset++) {
      const activeKey = GEMINI_KEYS[(startIdx + offset) % GEMINI_KEYS.length]
      for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest']) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(activeKey)}`
          const payloadBody = JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: {
              temperature: 0.8,
              maxOutputTokens: isDetailed ? 600 : 280,
              thinkingConfig: { thinkingBudget: 0 },
            },
          })
          let res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': activeKey,
            },
            body: payloadBody,
          })
          // If AQ. key requires Bearer header instead of query key
          if (!res.ok && activeKey.startsWith('AQ.')) {
            res = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${activeKey}`,
                  'x-goog-api-key': activeKey,
                },
                body: payloadBody,
              },
            )
          }
          if (res.ok) {
            const data = await res.json()
            const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim()
            if (text) return text
          } else {
            console.warn(`[Key #${((startIdx + offset) % GEMINI_KEYS.length) + 1} ${model}] HTTP ${res.status}`)
          }
        } catch (err) {
          console.warn(`[Key #${((startIdx + offset) % GEMINI_KEYS.length) + 1} ${model}] failed:`, err.message)
        }
      }
    }
  }

  // 2. Multi-model Keyless Free AI Backup Pool (rotates models so it never overloads)
  for (const backupModel of ['openai', 'mistral', 'llama']) {
    try {
      const pollRes = await fetch('https://text.pollinations.ai/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: backupModel,
          seed: Math.floor(Math.random() * 999999),
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
      console.warn(`[Backup ${backupModel}] error:`, err.message)
    }
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
        const targetJid = quotedMsg ? quotedParticipant : senderJid
        const targetName = resolveBestDisplayName(targetJid, sock.user)
        const aiAnswer = await generateGeminiReply({
          prompt: argText,
          quotedText: qText,
          targetName,
          targetJid,
          mode: 'ai',
        })
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
        const targetJid = quotedMsg ? quotedParticipant : senderJid
        const targetName = resolveBestDisplayName(targetJid, sock.user)
        const roastLine = await generateGeminiReply({
          prompt: argText,
          quotedText: qText,
          targetName,
          targetJid,
          mode: 'roast',
        })
        await sock.sendMessage(jid, { text: `*MODI CHATBOT:*\n\n${roastLine}` }, { quoted: msg })
        continue
      }

      // 6b. /kundali -> Open Student's IIIT Bhagalpur Mechatronics Kundali in Modi Ji Tone!
      if (cmd === '/kundali') {
        const targetJid = quotedMsg ? quotedParticipant : senderJid
        const targetName = argText || resolveBestDisplayName(targetJid, sock.user)
        const qText =
          quotedMsg?.conversation ||
          quotedMsg?.extendedTextMessage?.text ||
          ''
        const kundaliReply = await generateGeminiReply({
          prompt: `${targetName} ki puri kundali aur batch mein uske kaand batao!`,
          quotedText: qText,
          targetName,
          targetJid,
          mode: 'kundali',
        })
        await sock.sendMessage(jid, { text: `*MODI CHATBOT — KUNDALI:*\n\n${kundaliReply}` }, { quoted: msg })
        continue
      }

      // 7. /qai -> Generate AI Quote & Send as 512x512 Sticker!
      if (cmd === '/qai') {
        const qText =
          quotedMsg?.conversation ||
          quotedMsg?.extendedTextMessage?.text ||
          ''
        const targetJid = quotedParticipant || senderJid
        const senderName = resolveBestDisplayName(targetJid, sock.user)
        const aiQuote = await generateGeminiReply({
          prompt: argText || 'Ek funny backbencher ya coding quote likho',
          quotedText: qText,
          targetName: senderName,
          targetJid,
          mode: 'qai',
        })
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
              '• */kundali <naam>* (ya reply */kundali*) — Kisi bhi Mechatronics student ki Kundali kholo\n' +
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
