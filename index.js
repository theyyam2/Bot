const express = require('express');
const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('തെയ്യം വാട്സ്ആപ്പ് ബോട്ട് 24/7 റണ്ണിംഗ് ആണ്! 🤖');
});

app.listen(port, () => {
    console.log(`Keep-Alive സർവ്വീസ് പോർട്ട് ${port}-ൽ സ്റ്റാർട്ട് ആയി!`);
});

const { default: makeWASocket, useMultiFileAuthState, disconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("\n👇 താഴെ കാണുന്ന QR കോഡ് വാട്സ്ആപ്പിൽ സ്കാൻ ചെയ്യുക:\n");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== disconnectReason.loggedOut;
            console.log('ക്ലോസ് ആയി, വീണ്ടും കണക്ട് ചെയ്യുന്നു...', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ വാട്സ്ആപ്പ് ബോട്ട് വിജയകരമായി കണക്ട് ആയി!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg || !msg.message || msg.key.fromMe) return;

        const chat = msg.key.remoteJid;
        // ഗ്രൂപ്പ് മെസേജ് ആണോ എന്ന് ഉറപ്പാക്കുന്നു
        const isGroup = chat.endsWith('@g.us');
        if (!isGroup) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        // ലിങ്കുകൾ പരിശോധിക്കുന്നു
        const hasLink = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi.test(text);
        // ഗൂഗിൾ മാപ്പ് ഒഴിവാക്കുന്നു
        const isGoogleMap = /maps\.google\.com|maps\.app\.goo\.gl/gi.test(text);

        if (hasLink && !isGoogleMap) {
            try {
                // ലിങ്ക് അയച്ച മെസേജ് ഡിലീറ്റ് ചെയ്യുന്നു
                await sock.sendMessage(chat, { 
                    delete: {
                        remoteJid: chat,
                        fromMe: false,
                        id: msg.key.id,
                        participant: msg.key.participant
                    }
                });

                // മുന്നറിയിപ്പ് സന്ദേശം അയക്കുന്നു
                const sender = msg.key.participant;
                if (sender) {
                    await sock.sendMessage(chat, {
                        text: `⚠️ @${sender.split('@')[0]} ഈ ഗ്രൂപ്പിൽ ഗൂഗിൾ മാപ്പ് ലൊക്കേഷൻ ഒഴികെയുള്ള മറ്റ് ലിങ്കുകൾ അയക്കാൻ അനുവാദമില്ല!`,
                        mentions: [sender]
                    });
                }
            } catch (err) {
                console.log("ഡിലീറ്റ് ചെയ്യാൻ കഴിഞ്ഞില്ല: ", err.message);
            }
        }
    });
}

startBot();
