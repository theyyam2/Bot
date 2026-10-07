const express = require('express');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

// ---- Keep-alive സെർവർ ----
const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('തെയ്യം വാട്സ്ആപ്പ് ബോട്ട് റണ്ണിംഗ് ആണ്! 🤖'));
app.listen(port, () => console.log(`Keep-Alive സർവ്വീസ് പോർട്ട് ${port}-ൽ സ്റ്റാർട്ട് ആയി!`));

// അപ്രതീക്ഷിത എററുകൾ കൊണ്ട് പ്രോസസ് ക്രാഷ് ആകാതിരിക്കാൻ
process.on('uncaughtException', (e) => console.log('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.log('unhandledRejection:', e));

// ---- ലിങ്ക് പരിശോധന ----
const URL_RE = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
const ALLOWED_RE = /(maps\.google\.[a-z.]+|google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)/i;

function hasBadLink(text) {
    const links = text.match(URL_RE) || [];
    return links.some((l) => !ALLOWED_RE.test(l));   // ഒരു ലിങ്ക് എങ്കിലും അനുവദനീയമല്ലെങ്കിൽ true
}

// ---- ബോട്ട് ----
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join('/tmp', 'auth_info_baileys'));
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Theyyam Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n==========================================');
            console.log('👇 താഴെ കാണുന്ന QR കോഡ് വാട്സ്ആപ്പിൽ സ്കാൻ ചെയ്യുക:');
            console.log('==========================================');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('കണക്ഷൻ ക്ലോസ് ആയി. കോഡ്:', statusCode, '| റീകണക്ട്:', shouldReconnect);
            if (shouldReconnect) setTimeout(startBot, 3000);
        } else if (connection === 'open') {
            console.log('✅ വാട്സ്ആപ്പ് ബോട്ട് വിജയകരമായി കണക്ട് ആയി!');
        }
    });

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

                console.log('അനാവശ്യ ലിങ്ക് കണ്ടെത്തി! ഡിലീറ്റ് ചെയ്യാൻ ശ്രമിക്കുന്നു...');

                await sock.sendMessage(chat, {
                    delete: {
                        remoteJid: chat,
                        fromMe: false,
                        id: msg.key.id,
                        participant: msg.key.participant
                    }
                });

                const sender = msg.key.participant;
                if (sender) {
                    await sock.sendMessage(chat, {
                        text: `⚠️ @${sender.split('@')[0]} ഈ ഗ്രൂപ്പിൽ ഗൂഗിൾ മാപ്പ് ലൊക്കേഷൻ ഒഴികെയുള്ള മറ്റ് ലിങ്കുകൾ അയക്കാൻ അനുവാദമില്ല!`,
                        mentions: [sender]
                    });
                }
            } catch (err) {
                console.log('Error handling message:', err.message);
            }
        }
    });
}

startBot();
