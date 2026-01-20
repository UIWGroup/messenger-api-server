const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Railway configuration for temporary file handling
const upload = multer({ dest: '/tmp/' });
const DB_PATH = path.join(__dirname, 'db.json');

// --- ENVIRONMENT VARIABLES (Railway Panel) ---
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Local database for PSID mapping
let db = { psids: {} };
if (fs.existsSync(DB_PATH)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_PATH));
    } catch (e) {
        console.error("Error reading db.json, starting fresh.");
    }
}

// --- HELPER: FETCH PROFILE NAME FROM META ---
async function getClientName(psid) {
    try {
        const res = await axios.get(`https://graph.facebook.com/${psid}?fields=name&access_token=${PAGE_ACCESS_TOKEN}`);
        return res.data.name;
    } catch (e) {
        console.error("Meta API Name Fetch Error:", e.response?.data || e.message);
        return null;
    }
}

// --- 1. LEGAL PAGES (REQUIRED FOR LIVE MODE) ---

app.get('/privacy', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>Privacy Policy - NoviChat</title>
            <style>body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;line-height:1.6;padding:40px;max-width:900px;margin:auto;color:#333;} h1{color:#111;} h2{border-bottom:1px solid #eee;padding-bottom:10px;margin-top:30px;}</style>
        </head>
        <body>
            <h1>Privacy Policy</h1>
            <p><strong>Effective Date:</strong> January 20, 2026</p>
            <p><strong>NoviChat</strong> ("we," "our," or "us") provides automation tools for the Meta Messenger platform. This policy explains how we handle data to provide our services.</p>
            
            <h2>1. Data Collection</h2>
            <p>We process the Page-Scoped ID (PSID) and public profile names provided by the Meta API to enable messaging automation.</p>

            <h2>2. Data Usage</h2>
            <p>Your data is used strictly for routing media files (audio, video, images) to the intended recipient in the chat. Media files are deleted from our servers immediately after transmission.</p>

            <h2>3. Security</h2>
            <p>We use industry-standard SSL encryption and secure cloud infrastructure (Railway) to protect all information in transit.</p>

            <h2>4. Contact</h2>
            <p>Support email: <strong>jacquelinexavier.50@gmail.com</strong></p>
        </body>
        </html>
    `);
});

app.get('/terms', (req, res) => {
    res.send(`
        <html>
        <head><title>Terms of Service - NoviChat</title><style>body{font-family:sans-serif;line-height:1.6;padding:40px;max-width:900px;margin:auto;}</style></head>
        <body>
            <h1>Terms of Service</h1>
            <p>By using NoviChat, you agree to comply with Meta’s Platform Terms and Developer Policies. NoviChat is an automation tool designed for legitimate customer service interactions.</p>
            <h2>Usage Restrictions</h2>
            <p>Users are prohibited from using NoviChat for spam or unauthorized marketing. We reserve the right to terminate access for any violation of Meta's messaging policies.</p>
        </body>
        </html>
    `);
});

app.get('/data-deletion', (req, res) => {
    res.send(`
        <html>
        <head><title>Data Deletion - NoviChat</title><style>body{font-family:sans-serif;line-height:1.6;padding:40px;max-width:900px;margin:auto;}</style></head>
        <body>
            <h1>Data Deletion Instructions</h1>
            <p>To request the deletion of your data from NoviChat, please email <strong>jacquelinexavier.50@gmail.com</strong> with the subject line <strong>"Data Deletion Request - NoviChat"</strong>.</p>
            <p>We will purge all records associated with your PSID within 48 business hours.</p>
        </body>
        </html>
    `);
});

// --- 2. WEBHOOK MANAGEMENT ---

app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'page') {
        for (const entry of body.entry) {
            if (entry.messaging && entry.messaging[0]) {
                const psid = entry.messaging[0].sender.id;
                const name = await getClientName(psid);
                if (name) {
                    db.psids[name.toLowerCase()] = psid;
                    fs.writeFileSync(DB_PATH, JSON.stringify(db));
                    console.log(`✅ NOVICHAT MAPPING: ${name} -> ${psid}`);
                }
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    }
});

// --- 3. EXTENSION API ---

app.get('/api/get-psid-by-name', (req, res) => {
    const name = req.query.name?.toLowerCase();
    const psid = db.psids[name];
    if (psid) {
        res.json({ psid });
    } else {
        res.status(404).json({ error: "Customer not found in NoviChat DB" });
    }
});

app.post('/api/send-media', upload.single('file'), async (req, res) => {
    const { recipientId, type } = req.body;
    const file = req.file;

    try {
        const formData = new FormData();
        formData.append('recipient', JSON.stringify({ id: recipientId }));
        formData.append('message', JSON.stringify({
            attachment: { type: type, payload: { is_reusable: true } }
        }));
        formData.append('filedata', fs.createReadStream(file.path));

        await axios.post(
            `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            formData, { headers: formData.getHeaders() }
        );

        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        res.json({ success: true });
    } catch (error) {
        console.error('Meta API Error:', error.response?.data || error.message);
        if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        res.status(500).json({ success: false });
    }
});

// Dynamic Port for Railway
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 NOVICHAT SERVER ONLINE`);
    console.log(`📡 Domain: ${PORT} | Status: Connected`);
});