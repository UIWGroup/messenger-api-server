// 1. Configurações
require('dotenv').config(); 

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express(); 
app.set('trust proxy', true); // Necessário para pegar o IP real no Railway
app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÕES FACEBOOK ---
const FB_PIXEL_ID = '1412330650434939'; // O ID do novo Pixel do Business
const FB_ACCESS_TOKEN = 'EAAFh2fThjegBQkFZAff8Mh4RNuzypedBzFCWb5fmLwJWWWt3pTuXdBprg91xYWcuWiBAtw5BT9mgQycqhewLh7mzbVoyjEJDyzJUvLdR5BYGyGhAfR0LmBUC8BpfyvO0NF950vRnIzDeZBEZB8pZBZCE8IazPTNZAtCMaj6uglgwtieILqHL0ZCRAb9B6maDI7WuwZDZD';

// Railway Uploads
const upload = multer({ dest: '/tmp/' });
const DB_PATH = path.join(__dirname, 'db.json');

// --- ENV VARS ---
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

if (!supabase) console.warn("⚠️ AVISO: Supabase não configurado.");

// DB Local
let db = { psids: {} };
if (fs.existsSync(DB_PATH)) {
    try { db = JSON.parse(fs.readFileSync(DB_PATH)); } catch (e) {}
}

// --- HELPERS ---
function sha256(value) {
    if (!value) return undefined; // Retorna undefined para o JSON.stringify remover o campo
    return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

async function getClientName(psid) {
    try {
        const res = await axios.get(`https://graph.facebook.com/${psid}?fields=name&access_token=${PAGE_ACCESS_TOKEN}`);
        return res.data.name;
    } catch (e) { return null; }
}

// --- ROTAS BÁSICAS ---
app.get('/privacy', (req, res) => res.send('Privacy Policy'));
app.get('/terms', (req, res) => res.send('Terms'));
app.get('/data-deletion', (req, res) => res.send('Deletion Request'));

// --- WEBHOOK ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.status(200).send(req.query['hub.challenge']);
    else res.sendStatus(403);
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
                }
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    }
});

// --- API DE VENDAS ---

// FASE 1: REGISTRAR
app.post('/api/register-sale', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Supabase Missing" });
    try {
      const payload = req.body;
      const { data, error } = await supabase.from('sales').insert([{
            external_id: payload.external_id,
            event_id: payload.event_id,
            token: payload.token,
            full_name: payload.full_name,
            email: payload.email,
            phone: payload.phone,
            city: payload.city,
            state: payload.state,
            country: payload.country,
            product_name: payload.product_name,
            value: payload.value,
            currency: payload.currency,
            lead_source: payload.lead_source,
            lead_status: 'sale_created',
            created_at: new Date().toISOString()
      }]).select();
  
      if (error && error.code !== '23505') throw error;
      return res.status(201).json({ success: true, token: payload.token });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao salvar venda.' });
    }
});

// FASE 2: CONSULTAR
app.get('/api/consultar-pedido/:token', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Erro interno" });
    const { token } = req.params;
    try {
        const { data, error } = await supabase.from('sales').select('*').eq('token', token).single();
        if (error || !data) return res.status(404).json({ success: false });
        res.json({
            success: true,
            full_name: data.full_name,
            product_name: data.product_name,
            value: data.value,
            currency: data.currency,
            status: data.lead_status
        });
    } catch (err) { res.status(500).json({ error: "Erro" }); }
});

// FASE 3: CONFIRMAR + PIXEL (Versão Blindada)
app.post('/api/confirmar-pedido', async (req, res) => {
    // 1. Recebe fbc e fbp do site
    const { token, age, gender, fbc, fbp } = req.body; 
    
    // Captura dados técnicos
    const clientUserAgent = req.headers['user-agent'];
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        // ... (código de atualização do Supabase continua igual) ...

        // 2. Prepara User Data COM OS COOKIES
        const userData = {
            em: sale.email ? [sha256(sale.email)] : undefined,
            ph: sale.phone ? [sha256(sale.phone)] : undefined,
            // ... (outros campos iguais) ...
            client_user_agent: clientUserAgent,
            client_ip_address: clientIp,
            fbc: fbc || undefined, // <--- ADICIONADO
            fbp: fbp || undefined  // <--- ADICIONADO
        };

        // Remove chaves undefined
        Object.keys(userData).forEach(key => userData[key] === undefined && delete userData[key]);

        const eventData = {
            data: [{
                event_name: 'Purchase',
                event_time: Math.floor(Date.now() / 1000),
                event_id: sale.event_id,
                event_source_url: 'https://helpvitalllc.com/confirmed',
                action_source: 'website',
                user_data: userData,
                custom_data: {
                    value: parseFloat(sale.value),
                    currency: sale.currency || 'USD',
                    content_name: sale.product_name,
                    customer_age: age,
                    customer_gender: gender
                }
            }]
        };

        console.log(`📡 Enviando evento para Pixel: ${FB_PIXEL_ID}...`);
        
        await axios.post(
            `https://graph.facebook.com/v19.0/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`,
            eventData
        );

        console.log("✅ PIXEL DISPARADO COM SUCESSO! (Status 200)");
        await supabase.from('sales').update({ pixel_status: 'sent' }).eq('id', sale.id);
        res.json({ success: true });

    } catch (err) {
        // Log Detalhado do Erro do Facebook
        const fbError = err.response ? JSON.stringify(err.response.data) : err.message;
        console.error(`❌ ERRO NO PIXEL: ${fbError}`);
        
        // Retorna sucesso para o site não travar, mas loga o erro
        res.json({ success: true, warning: "Salvo no banco, erro no pixel." }); 
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 NOVICHAT SERVER ONLINE`));
