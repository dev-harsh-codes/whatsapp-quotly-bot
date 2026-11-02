# QuotLy Bhai WhatsApp Bot (Heroku + GitHub Auto-Deploy)

Yeh repository tumhare **WhatsApp `/q` Quote-to-Sticker Bot** ka complete Node.js (Baileys) worker hai jo tumhare **Payload CMS + Sharp Backend** (`https://ta-01m6da85d51j1wk6fge1gmby0v-1380-yffpduldc7jqjk00cb80baym5.makeproxy-m.figma.site`) se connected hai.

## Features
- **`/q` (Reply to any message):** Quoted message ka sender name, avatar, nested reply, aur timestamp lekar **512x512 transparent WebP sticker** banata hai (`/q`, `/q neon`, `/q telegram`, `/q light`).
- **`/s` (Reply to photo):** Kisi bhi photo ko 512x512 WhatsApp sticker mein convert karta hai.
- **`/toimg` (Reply to sticker):** Sticker ko HD PNG photo mein badalta hai.
- **`/tagall` (Groups):** Group ke saare members ko ek saath tag karta hai.
- **8-Digit Pairing Code + Web QR:** Heroku par bina terminal खोलें phone number se link karo.

## Heroku Par Deploy Kaise Karein (Step-by-Step)

1. **Heroku Dashboard** mein jao -> **New** -> **Create new app**.
2. **Deploy** tab mein jao -> **Deployment method** mein **GitHub** select karo.
3. Apna yeh GitHub repo search karke **Connect** par click karo.
4. **Automatic deploys** ko **Enable** kar do (taaki jab bhi hum dashboard se GitHub par push karein, Heroku khud deploy kar de!).
5. **Settings** tab -> **Reveal Config Vars** mein ye set karo:
   - `PAIRING_NUMBER`: Apna WhatsApp number country code ke saath (jaise `919876543210`)
   - `BOT_BACKEND_URL`: `https://ta-01m6da85d51j1wk6fge1gmby0v-1380-yffpduldc7jqjk00cb80baym5.makeproxy-m.figma.site`
6. **Deploy Branch** par click karo aur apne Heroku app URL (`https://<your-app>.herokuapp.com`) ko open karke **8-digit Pairing Code** ya **QR Code** se WhatsApp link kar lo!
