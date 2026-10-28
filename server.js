const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const activeSessions = {};

app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const sessionFolder = path.join(__dirname, 'temp_sessions', cleanNumber);
    
    // Force cleanup to always generate a fresh code
    if (fs.existsSync(sessionFolder)) {
        fs.rmSync(sessionFolder, { recursive: true, force: true });
    }
    fs.mkdirSync(sessionFolder, { recursive: true });

    try {
        const { version, isLatest } = await fetchLatestWaWebVersion();
        console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        
        const sock = makeWASocket({
            version: version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
        });

        sock.ev.on('creds.update', saveCreds);

        setTimeout(async () => {
            try {
                const rawCode = await sock.requestPairingCode(cleanNumber);
                const formattedCode = rawCode.match(/.{1,4}/g).join('-');
                
                activeSessions[cleanNumber] = { sock, code: formattedCode, status: 'waiting', sessionId: null, error: null };
                res.json({ success: true, code: formattedCode });
            } catch (e) {
                res.status(500).json({ error: 'Failed to generate code: ' + e.message });
            }
        }, 5000);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`✅ ${cleanNumber} paired successfully!`);
                
                setTimeout(async () => {
                    try {
                        const files = fs.readdirSync(sessionFolder);
                        const sessionData = {};
                        for (const file of files) {
                            if (file.endsWith('.json')) {
                                const content = fs.readFileSync(path.join(sessionFolder, file));
                                sessionData[file] = content.toString('base64');
                            }
                        }
                        
                        const sessionId = Buffer.from(JSON.stringify(sessionData)).toString('base64');
                        
                        if (activeSessions[cleanNumber]) {
                            activeSessions[cleanNumber].status = 'success';
                            activeSessions[cleanNumber].sessionId = sessionId;
                        }

                        try {
                            const dmMessage = `🔐 *ESSENZA MD SESSION ID*\n\n` +
                                              `Here is your generated Session ID. Please keep it secret.\n\n` +
                                              `\`${sessionId}\`\n\n` +
                                              `Copy the text above and paste it into the *SESSION_ID* environment variable on your hosting panel.`;
                             
                            await sock.sendMessage(cleanNumber + '@s.whatsapp.net', { text: dmMessage });
                            console.log(`📩 Session ID successfully sent to ${cleanNumber} via DM.`);
                        } catch (err) {
                            console.error('Failed to send DM:', err.message);
                        }
                    } catch (e) {
                        console.error('Error generating session ID:', e);
                    }
                }, 5000);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errorMessage = lastDisconnect?.error?.message || 'Unknown error';
                
                console.log(`❌ ${cleanNumber} connection closed. Code: ${statusCode}, Error: ${errorMessage}`);
                
                // Save the error to the session so the frontend can display it
                if (activeSessions[cleanNumber]) {
                    activeSessions[cleanNumber].status = 'failed';
                    activeSessions[cleanNumber].error = `Connection failed (Code: ${statusCode}). WhatsApp may be blocking this server's IP.`;
                }
            }
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/status/:phoneNumber', (req, res) => {
    const { phoneNumber } = req.params;
    const session = activeSessions[phoneNumber];
    if (!session) return res.status(404).json({ error: 'Session not found' });
    
    res.json({ status: session.status, sessionId: session.sessionId, error: session.error });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pairing Server running on port ${PORT}`));
