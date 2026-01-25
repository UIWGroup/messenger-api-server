// 1. Configurações (Sempre a primeira linha)
require('dotenv').config(); 

// 2. Importações
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto'); // <--- NOVO: Para segurança do Facebook

// 3. Inicialização
const app = express(); 
app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÕES DO FACEBOOK API (FASE 3) ---
const FB_PIXEL_ID = '1540829440322110';
const FB_ACCESS_TOKEN = 'EAAV5YE9zKj4BQk967JHfeOHukRvMA7lLgUq4IsRInxMMmZBPyWeia5gxRd9jor8lvEVLOENHQ5mFhzSGaQv0VaZA5GdCE0CfHWiZAmKFtNV0kRF3MG0dk8PcQmCS2k1odO6ceqo2XMZBLUaBzkcvwnOXEwi7l8OqtPgMYXfsfOoNis0dAvZAvRk3dF8Rpk9nwUBrtM8ZC87IipnoBwZBpVGY4DEMAZDZD';

// Railway configuration for temporary file handling
const upload = multer({ dest: '/tmp/' });
const DB_PATH = path.join(__dirname, 'db.json');

// --- ENVIRONMENT VARIABLES (Railway Panel) ---
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// 👉 Configuração da Caixa Forte (Supabase)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

if (!supabase) console.warn("⚠️ AVISO: Supabase não configurado. Adicione as variáveis no Railway.");

// Local database for PSID mapping
let db = { psids: {} };
if (fs.existsSync(DB_PATH)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_PATH));
    } catch (e) {
        console.error("Error reading db.json, starting fresh.");
    }
}

// --- HELPER: HASH SHA256 (SEGURANÇA FACEBOOK) ---
function sha256(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
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

// --- 1. LEGAL PAGES ---
app.get('/privacy', (req, res) => res.send(`<html><body><h1>Privacy Policy</h1><p>NoviChat Privacy Policy...</p></body></html>`));
app.get('/terms', (req, res) => res.send(`<html><body><h1>Terms of Service</h1><p>NoviChat Terms...</p></body></html>`));
app.get('/data-deletion', (req, res) => res.send(`<html><body><h1>Data Deletion</h1><p>Request deletion at support@novichat.com</p></body></html>`));

// --- 2. WEBHOOK MANAGEMENT (Mantido intacto) ---
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

// --- 3. EXTENSION API & FUNNEL ---

// Rotas Legadas (Mantidas)
app.get('/api/get-psid-by-name', (req, res) => {
    const name = req.query.name?.toLowerCase();
    const psid = db.psids[name];
    if (psid) res.json({ psid });
    else res.status(404).json({ error: "Customer not found" });
});

app.post('/api/send-media', upload.single('file'), async (req, res) => {
    const { recipientId, type } = req.body;
    const file = req.file;
    try {
        const formData = new FormData();
        formData.append('recipient', JSON.stringify({ id: recipientId }));
        formData.append('message', JSON.stringify({ attachment: { type: type, payload: { is_reusable: true } } }));
        formData.append('filedata', fs.createReadStream(file.path));

        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, formData, { headers: formData.getHeaders() });
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        res.json({ success: true });
    } catch (error) {
        if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        res.status(500).json({ success: false });
    }
});

// --- 4. SALES TRACKING SYSTEM (NOVO SISTEMA) ---

// FASE 1: REGISTRAR VENDA (Extensão -> Supabase)
app.post('/api/register-sale', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Supabase Missing" });
    try {
      const payload = req.body;
      if (!payload.external_id || !payload.token) return res.status(400).json({ error: 'Payload incompleto.' });
  
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
  
      if (error) {
        if (error.code === '23505') return res.status(200).json({ success: true, message: 'Venda já registrada.' });
        throw error;
      }
      return res.status(201).json({ success: true, token: payload.token });
    } catch (err) {
      console.error('[ERRO]', err);
      return res.status(500).json({ error: 'Erro ao salvar venda.' });
    }
});

// FASE 2: CONSULTAR PEDIDO (Site -> Supabase)
app.get('/api/consultar-pedido/:token', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Erro interno (DB)" });
    const { token } = req.params;
    try {
        const { data, error } = await supabase.from('sales').select('*').eq('token', token).single();
        if (error || !data) return res.status(404).json({ success: false, error: "Pedido não encontrado" });
        res.json({
            success: true,
            full_name: data.full_name,
            product_name: data.product_name,
            value: data.value,
            currency: data.currency,
            status: data.lead_status
        });
    } catch (err) { res.status(500).json({ error: "Erro ao processar." }); }
});

// FASE 3: CONFIRMAR + DISPARAR PIXEL (Site -> Supabase -> Facebook)
app.post('/api/confirmar-pedido', async (req, res) => {
    const { token, age, gender } = req.body;

    try {
        // 1. Atualiza o banco com Idade/Sexo
        const { data: sale, error } = await supabase
            .from('sales')
            .update({ 
                age: parseInt(age), 
                gender: gender, 
                lead_status: 'sale_confirmed',
                updated_at: new Date()
            })
            .eq('token', token)
            .select()
            .single();

        if (error || !sale) throw new Error("Erro ao atualizar banco.");

        // 2. PREPARA OS DADOS PARA O FACEBOOK (CAPI)
        // Criptografia SHA256 é obrigatória para o Facebook aceitar os dados
        const eventData = {
            data: [{
                event_name: 'Purchase',
                event_time: Math.floor(Date.now() / 1000),
                event_id: sale.event_id, // Deduplicação exata com o navegador (se houvesse pixel lá)
                event_source_url: 'https://helpvitalllc.com/confirmed',
                action_source: 'website',
                user_data: {
                    em: [sha256(sale.email)], 
                    ph: [sha256(sale.phone)], 
                    ct: [sha256(sale.city)],
                    st: [sha256(sale.state)],
                    country: [sha256(sale.country)],
                    external_id: [sha256(sale.external_id)],
                    client_user_agent: 'NoviChat-Server-Agent'
                },
                custom_data: {
                    value: parseFloat(sale.value),
                    currency: sale.currency || 'USD',
                    content_name: sale.product_name,
                    status: 'confirmed_with_profile',
                    customer_age: age,
                    customer_gender: gender
                }
            }]
        };

        // 3. ENVIA PARA O MARK ZUCKERBERG
        console.log(`📡 Enviando evento Purchase para o Facebook (Pixel: ${FB_PIXEL_ID})...`);
        
        await axios.post(
            `https://graph.facebook.com/v19.0/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`,
            eventData
        );

        console.log("✅ PIXEL DISPARADO COM SUCESSO!");

        // 4. Marca no banco que o pixel foi enviado
        await supabase.from('sales').update({ pixel_status: 'sent' }).eq('id', sale.id);

        res.json({ success: true });

    } catch (err) {
        console.error("❌ Erro no processo (Pixel ou DB):", err.message);
        // Retornamos sucesso pois o dado do cliente foi salvo, mesmo que o pixel falhe
        res.json({ success: true, warning: "Dados salvos, mas erro na comunicação com Facebook." }); 
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 NOVICHAT SERVER ONLINE NA PORTA ${PORT}`));
