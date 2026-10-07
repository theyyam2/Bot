const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

/* ============ വെബ് സെർവർ (+ QR പേജ്) ============ */
const app = express();
const port = process.env.PORT || 10000;

let latestQR = null;
let connected = false;

app.get('/', (req, res) => res.send('തെയ്യം വാട്സ്ആപ്പ് ബോട്ട് റണ്ണിംഗ് ആണ്! 🤖'));

app.get('/qr', async (req, res) => {
    // ഓപ്ഷണൽ: Render env-ൽ QR_KEY ഇട്ടാൽ /qr?key=... എന്ന് മാത്രമേ തുറക്കൂ
    if (process.env.QR_KEY && req.query.key !== process.env.QR_KEY) {
        return res.status(403).send('അനുവാദമില്ല');
    }
    if (connected) {
        return res.send('<h2 style="font-family:sans-serif;text-align:center">✅ ബോട്ട് കണക്ട് ആണ്. QR ആവശ്യമില്ല.</h2>');
    }
    if (!latestQR) {
        return res.send('<p style="font-family:sans-serif;text-align:center">QR തയ്യാറാകുന്നു... കുറച്ച് സെക്കൻഡ് കാത്തിരിക്കൂ.</p><script>setTimeout(()=>location.reload(),4000)</script>');
    }
    const img = await QRCode.toDataURL(latestQR, { width: 320, margin: 2 });
    res.send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="text-align:center;font-family:sans-serif">
<h3>വാട്സ്ആപ്പ് → Linked devices → Link a device → ഈ QR സ്കാൻ ചെയ്യുക</h3>
<img src="${img}" width="320" height="320">
<p>QR ഇടയ്ക്കിടെ മാറും, പേജ് സ്വയം പുതുക്കും.</p>
<script>setTimeout(()=>location.reload(),10000)</script>
</body></html>`);
});

app.listen(port, () => console.log(`വെബ് സർവ്വീസ് പോർട്ട് ${port}-ൽ സ്റ്റാർട്ട് ആയി!`));

process.on('uncaughtException', (e) => console.log('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.log('unhandledRejection:', e));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============ ലിങ്ക് പരിശോധന ============ */
const URL_RE = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
const ALLOWED_RE = /(maps\.google\.[a-z.]+|google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)/i;

function hasBadLink(text) {
    const links = text.match(URL_RE) || [];
    return links.some((l) => !ALLOWED_RE.test(l));   // ഒരു ലിങ്ക് എങ്കിലും അനുവദനീയമല്ലെങ്കിൽ true
}

/* ============ ബോട്ട് ============ */
const AUTH_DIR = path.join('/tmp', 'auth_info_baileys');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            console.log('📲 QR തയ്യാറാണ്: https://<നിങ്ങളുടെ-render-url>/qr എന്ന പേജ് തുറന്ന് സ്കാൻ ചെയ്യുക');
        }

        if (connection === 'close') {
            connected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log('കണക്ഷൻ ക്ലോസ് ആയി. കോഡ്:', statusCode);

            if (statusCode === DisconnectReason.loggedOut) {
                // ലോഗൗട്ട് ആയി: പഴയ സെഷൻ മായ്ച്ച് പുതിയ QR ഉണ്ടാക്കുന്നു
                console.log('⚠️ ലോഗൗട്ട് ആയി. സെഷൻ മായ്ക്കുന്നു...');
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            }
            setTimeout(startBot, 3000);
        } else if (connection === 'open') {
            connected = true;
            latestQR = null;
            console.log('✅ വാട്സ്ആപ്പ് ബോട്ട് വിജയകരമായി കണക്ട് ആയി!');
        }
    });

    // ---- ഗ്രൂപ്പ് മെസ്സേജുകൾ: ലിങ്ക് ഉണ്ടെങ്കിൽ ഡിലീറ്റ് മാത്രം (മുന്നറിയിപ്പ് ഇല്ല) ----
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;            // പഴയ (history) മെസ്സേജുകൾ ഒഴിവാക്കുന്നു

        for (const msg of messages) {
            try {
                if (!msg.message || msg.key.fromMe) continue;

                const chat = msg.key.remoteJid;
                if (!chat || !chat.endsWith('@g.us')) continue;   // ഗ്രൂപ്പുകൾ മാത്രം

                const text =
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption || '';

                if (!text || !hasBadLink(text)) continue;

                console.log('അനാവശ്യ ലിങ്ക് കണ്ടെത്തി! ഡിലീറ്റ് ചെയ്യുന്നു...');
                await sleep(500 + Math.random() * 1500);          // 0.5–2 സെക്കൻഡ് താമസം

                await sock.sendMessage(chat, {
                    delete: {
                        remoteJid: chat,
                        fromMe: false,
                        id: msg.key.id,
                        participant: msg.key.participant
                    }
                });
            } catch (err) {
                console.log('Error handling message:', err.message);
            }
        }
    });
}

startBot();
