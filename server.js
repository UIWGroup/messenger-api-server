// 1. Configurações (Sempre a primeira linha)
require('dotenv').config(); 

// 2. Importações (Devem vir antes de serem usadas)
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// 3. Inicialização (Só aqui você pode usar as variáveis acima)
const app = express(); // <--- Agora o 'express' já existe e não dará erro
app.use(cors());
app.use(express.json());

// Railway configuration for temporary file handling
const upload = multer({ dest: '/tmp/' });
const DB_PATH = path.join(__dirname, 'db.json');

// --- ENVIRONMENT VARIABLES (Railway Panel) ---
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// 👉 Configuração da Caixa Forte (Supabase)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
// Inicializa o cliente apenas se as chaves existirem
const supabase = (supabaseUrl && supabaseKey) 
    ? createClient(supabaseUrl, supabaseKey) 
    : null;

if (!supabase) console.warn("⚠️ AVISO: Supabase não configurado. Adicione as variáveis no Railway.");

// Local database for PSID mapping (Mantido do seu código original)
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
    res.send(`<html><body><h1>Privacy Policy</h1><p>NoviChat Privacy Policy...</p></body></html>`);
});

app.get('/terms', (req, res) => {
    res.send(`<html><body><h1>Terms of Service</h1><p>NoviChat Terms...</p></body></html>`);
});

app.get('/data-deletion', (req, res) => {
    res.send(`<html><body><h1>Data Deletion</h1><p>Request deletion at jacquelinexavier.50@gmail.com</p></body></html>`);
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

// 🚀 ROTA FASE 1: REGISTRAR VENDA (EXTENSÃO -> SUPABASE)
app.post('/api/register-sale', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Servidor mal configurado (Supabase Missing)" });

    try {
      const payload = req.body;
  
      // Validação Básica
      if (!payload.external_id || !payload.token) {
        return res.status(400).json({ error: 'Payload incompleto.' });
      }
  
      console.log(`[FASE 1] Recebendo venda: ${payload.external_id}`);
  
      // Inserção no Supabase
      const { data, error } = await supabase
        .from('sales')
        .insert([
          {
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
          }
        ])
        .select();
  
      // Tratamento de Duplicidade (Segurança)
      if (error) {
        if (error.code === '23505') { 
          console.warn(`[DUPLICIDADE] Venda ${payload.external_id} já existe.`);
          return res.status(200).json({ success: true, message: 'Venda já registrada.' });
        }
        throw error;
      }
  
      console.log(`[SUCESSO] Venda salva! Token: ${payload.token}`);
      return res.status(201).json({ success: true, token: payload.token });
  
    } catch (err) {
      console.error('[ERRO INTERNO]', err);
      return res.status(500).json({ error: 'Erro ao salvar venda.' });
    }
});

// Rotas antigas da API (Mantidas)
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

// --- FASE 2: ROTA PARA O SEU SITE CONSULTAR (API JSON) ---
app.get('/api/consultar-pedido/:token', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Erro interno (DB)" });
    
    const { token } = req.params;

    try {
        // 1. Busca a venda pelo Token Seguro
        const { data, error } = await supabase
            .from('sales')
            .select('*')
            .eq('token', token)
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: "Pedido não encontrado ou expirado." });
        }

        // 2. Retorna apenas os dados seguros para o seu site exibir
        res.json({
            success: true,
            full_name: data.full_name,
            product_name: data.product_name,
            value: data.value,
            currency: data.currency,
            status: data.lead_status // 'sale_created' ou 'sale_confirmed'
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erro ao processar." });
    }
});

// --- ROTA DE CONFIRMAÇÃO FINAL + ATUALIZAÇÃO ---
app.post('/api/confirmar-pedido', async (req, res) => {
    const { token, age, gender } = req.body;

    if (!token) return res.status(400).json({ error: "Token obrigatório" });

    try {
        // 1. Atualiza os dados no Supabase e muda status para 'confirmed'
        const { data, error } = await supabase
            .from('sales')
            .update({ 
                age: parseInt(age), 
                gender: gender,
                lead_status: 'sale_confirmed',
                updated_at: new Date()
            })
            .eq('token', token)
            .select() // Retorna o dado atualizado para usarmos no Pixel
            .single();

        if (error) throw error;

        // 2. AQUI ENTRARÁ O DISPARO DO PIXEL (FASE 3)
        // Por enquanto, vamos apenas logar que funcionou
        console.log("✅ Venda Confirmada e Enriquecida:", data.full_name);

        res.json({ success: true, message: "Dados atualizados!" });

    } catch (err) {
        console.error("Erro ao confirmar:", err);
        res.status(500).json({ error: "Erro ao processar confirmação." });
    }
});

// Dynamic Port for Railway
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 NOVICHAT SERVER ONLINE`);
    console.log(`📡 Domain: ${PORT} | Status: Connected`);
});
