const express = require('express');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { MongoClient } = require('mongodb');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    initAuthCreds,
    BufferJSON,
    proto
} = require('@whiskeysockets/baileys');

/* ============ Keep-alive സെർവർ ============ */
const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('തെയ്യം വാട്സ്ആപ്പ് ബോട്ട് റണ്ണിംഗ് ആണ്! 🤖'));
app.listen(port, () => console.log(`Keep-Alive സർവ്വീസ് പോർട്ട് ${port}-ൽ സ്റ്റാർട്ട് ആയി!`));

// Render ഫ്രീ പ്ലാൻ ഉറങ്ങാതിരിക്കാൻ ഓരോ 10 മിനിറ്റിലും സ്വന്തം URL പിംഗ് ചെയ്യുന്നു
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
    setInterval(() => {
        fetch(SELF_URL).then(() => console.log('🔄 self-ping ok')).catch(() => {});
    }, 10 * 60 * 1000);
}

process.on('uncaughtException', (e) => console.log('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.log('unhandledRejection:', e));

/* ============ MongoDB-ൽ സെഷൻ സൂക്ഷിക്കൽ ============ */
async function useMongoAuthState(collection) {
    const write = (data, id) =>
        collection.replaceOne({ _id: id }, { _id: id, data: JSON.stringify(data, BufferJSON.replacer) }, { upsert: true });
    const read = async (id) => {
        const doc = await collection.findOne({ _id: id });
        return doc ? JSON.parse(doc.data, BufferJSON.reviver) : null;
    };
    const remove = (id) => collection.deleteOne({ _id: id });

    const creds = (await read('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await read(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? write(value, key) : remove(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => write(creds, 'creds')
    };
}

let authCollection = null;
async function getAuth() {
    if (process.env.MONGODB_URI) {
        if (!authCollection) {
            const client = new MongoClient(process.env.MONGODB_URI);
            await client.connect();
            authCollection = client.db('theyyam_bot').collection('auth');
            console.log('✅ MongoDB കണക്ട് ആയി (സെഷൻ സ്ഥിരമായി സൂക്ഷിക്കും)');
        }
        return useMongoAuthState(authCollection);
    }
    console.log('⚠️ MONGODB_URI ഇല്ല. സെഷൻ /tmp-ൽ (റീസ്റ്റാർട്ടിൽ മായും)');
    return useMultiFileAuthState(path.join('/tmp', 'auth_info_baileys'));
}

/* ============ ലിങ്ക് പരിശോധന ============ */
const URL_RE = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
const ALLOWED_RE = /(maps\.google\.[a-z.]+|google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)/i;

function hasBadLink(text) {
    const links = text.match(URL_RE) || [];
    return links.some((l) => !ALLOWED_RE.test(l));   // ഒരു ലിങ്ക് എങ്കിലും അനുവദനീയമല്ലെങ്കിൽ true
}

/* ============ ബോട്ട് ============ */
async function startBot() {
    const { state, saveCreds } = await getAuth();
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    // ---- ആദ്യ ലിങ്കിങ്: പെയറിങ് കോഡ് ----
    const pairNumber = (process.env.PAIR_NUMBER || '').replace(/\D/g, '');
    if (!sock.authState.creds.registered && pairNumber) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(pairNumber);
                console.log('\n🔑 പെയറിങ് കോഡ്:', code, '\n');
            } catch (e) {
                console.log('പെയറിങ് കോഡ് എടുക്കാൻ പറ്റിയില്ല:', e.message);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !pairNumber) {
            console.log('\n👇 QR കോഡ് (PAIR_NUMBER ഉപയോഗിക്കുന്നത് എളുപ്പമാണ്):');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log('കണക്ഷൻ ക്ലോസ് ആയി. കോഡ്:', statusCode);

            if (statusCode === DisconnectReason.loggedOut) {
                // വാട്സ്ആപ്പിൽ നിന്ന് ലോഗൗട്ട് ചെയ്തു: പഴയ സെഷൻ മായ്ച്ച് വീണ്ടും ലിങ്ക് ചെയ്യണം
                console.log('⚠️ ലോഗൗട്ട് ആയി. സെഷൻ മായ്ക്കുന്നു...');
                if (authCollection) await authCollection.deleteMany({});
                if (pairNumber) {
                    setTimeout(startBot, 3000);
                } else {
                    console.log('PAIR_NUMBER ചേർത്ത് വീണ്ടും ഡെപ്ലോയ് ചെയ്യുക.');
                }
            } else {
                setTimeout(startBot, 3000);
            }
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
