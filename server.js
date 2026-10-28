const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// In-memory storage for active sessions
const activeSessions = {};

app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    
    // Create a temporary folder for this session
    const sessionFolder = path.join(__dirname, 'temp_sessions', cleanNumber);
    if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

    try {
        // Fetch the latest WhatsApp Web version to prevent "Couldn't link device" errors
        const { version, isLatest } = await fetchLatestWaWebVersion();
        console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        
        const sock = makeWASocket({
            version: version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Essenza Pairing', 'Chrome', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        if (sock.authState.creds.registered) {
            return res.status(400).json({ error: 'This number is already paired. Please use a new number.' });
        }

        // Request the pairing code
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(cleanNumber);
                activeSessions[cleanNumber] = { sock, code, status: 'waiting', sessionId: null };
                res.json({ success: true, code });
            } catch (e) {
                res.status(500).json({ error: 'Failed to generate code: ' + e.message });
            }
        }, 3000);

        // Listen for connection
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`✅ ${cleanNumber} paired successfully!`);
                
                // Wait 5 seconds for all creds (keys, etc) to save to disk
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
                        
                        // Convert to Base64 String
                        const sessionId = Buffer.from(JSON.stringify(sessionData)).toString('base64');
                        
                        if (activeSessions[cleanNumber]) {
                            activeSessions[cleanNumber].status = 'success';
                            activeSessions[cleanNumber].sessionId = sessionId;
                        }

                        // --- SEND SESSION ID TO THE USER'S DM ---
                        try {
                            const dmMessage = `🔐 *ESSENZA MD SESSION ID*\n\n` +
                                              `Here is your generated Session ID. Please keep it secret and do not share it with anyone.\n\n` +
                                              `\`${sessionId}\`\n\n` +
                                              `Copy the text above and paste it into the *SESSION_ID* environment variable on your hosting panel.`;
                             
                            // Send to the user's own number (Message Yourself)
                            await sock.sendMessage(cleanNumber + '@s.whatsapp.net', { text: dmMessage });
                            console.log(`📩 Session ID successfully sent to ${cleanNumber} via DM.`);
                        } catch (err) {
                            console.error('Failed to send DM:', err.message);
                        }
                        // ---------------------------------------------
                        
                        // Clean up the folder to save space
                        fs.rmSync(sessionFolder, { recursive: true, force: true });
                    } catch (e) {
                        console.error('Error generating session ID:', e);
                    }
                }, 5000);
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (!shouldReconnect) console.log(`❌ ${cleanNumber} logged out.`);
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
    
    res.json({ status: session.status, sessionId: session.sessionId });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pairing Server running on port ${PORT}`));
