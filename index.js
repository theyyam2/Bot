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
const path = require('path');

async function startBot() {
    // താൽക്കാലിക ഫോൾഡറിലേക്ക് സെഷൻ മാറ്റുന്നു
    const { state, saveCreds } = await useMultiFileAuthState(path.join('/tmp', 'auth_info_baileys'));
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: ["Theyyam Bot", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("\n👇 താഴെ കാണുന്ന QR കോഡ് വാട്സ്ആപ്പിൽ സ്കാൻ ചെയ്യുക:\n");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== disconnectReason.loggedOut;
            console.log('കണക്ഷൻ ക്ലോസ് ആയി, വീണ്ടും ശ്രമിക്കുന്നു...', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(startBot, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ വാട്സ്ആപ്പ് ബോട്ട് വിജയകരമായി കണക്ട് ആയി!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message || msg.key.fromMe) return;

            const chat = msg.key.remoteJid;
            const isGroup = chat.endsWith('@g.us');
            if (!isGroup) return;

            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || "";

            const hasLink = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi.test(text);
            const isGoogleMap = /maps\.google\.com|maps\.app\.goo\.gl/gi.test(text);

            if (hasLink && !isGoogleMap) {
                // സന്ദേശം ഡിലീറ്റ് ചെയ്യുന്നു
                await sock.sendMessage(chat, { 
                    delete: {
                        remoteJid: chat,
                        fromMe: false,
                        id: msg.key.id,
                        participant: msg.key.participant
                    }
                });

                // വാണിംഗ് അയക്കുന്നു
                const sender = msg.key.participant;
                if (sender) {
                    await sock.sendMessage(chat, {
                        text: `⚠️ @${sender.split('@')[0]} ഈ ഗ്രൂപ്പിൽ ഗൂഗിൾ മാപ്പ് ലൊക്കേഷൻ ഒഴികെയുള്ള മറ്റ് ലിങ്കുകൾ അയക്കാൻ അനുവാദമില്ല!`,
                        mentions: [sender]
                    });
                }
            }
        } catch (err) {
            console.log("Error handling message:", err.message);
        }
    });
}

startBot();
