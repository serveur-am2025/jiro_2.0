// ========================================
// SERVEUR IoT LAMPADAIRES - Render + PostgreSQL
// Node.js + Express + PostgreSQL + WebSocket
// ========================================
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const WebSocket = require('ws');
const crypto = require('crypto');
const cors = require('cors');
const http = require('http');

const app = express();
app.use(express.json());
app.use(cors());

// ========================================
// CONFIGURATION POSTGRESQL
// ========================================
const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
};

const pool = new Pool(poolConfig);

async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('✅ PostgreSQL connecté à Neon');
    client.release();
    return true;
  } catch (error) {
    console.error('❌ Erreur connexion PostgreSQL:', error.message);
    return false;
  }
}

pool.on('error', (err) => console.error('❌ Erreur PostgreSQL inattendue:', err.message));

// ========================================
// INITIALISATION BASE DE DONNÉES
// ========================================
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS lampadaires (
        id VARCHAR(50) PRIMARY KEY,
        mac VARCHAR(17) UNIQUE NOT NULL,
        latitude DECIMAL(10,7),
        longitude DECIMAL(10,7),
        altitude DECIMAL(8,2) DEFAULT 0.0,
        lieu_installation VARCHAR(255),
        date_installation DATE,
        status VARCHAR(20) DEFAULT 'OFF',
        sw420_state VARCHAR(20) DEFAULT 'INACTIVE',
        signal INTEGER DEFAULT 0,
        token VARCHAR(255),
        last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_mac ON lampadaires(mac)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_status ON lampadaires(status)');
    await client.query('COMMIT');
    console.log('✅ Base de données initialisée avec succès');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erreur initialisation base:', error.message);
  } finally {
    client.release();
  }
}

// ========================================
// GÉNÉRATION TOKEN / ID SÉQUENTIEL
// ========================================
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ✅ NOUVELLE FONCTION : Génération ID séquentiel
async function generateLampId() {
  try {
    // Récupérer le dernier ID utilisé
    const result = await pool.query(
      "SELECT id FROM lampadaires WHERE id LIKE 'LAMP%' ORDER BY id DESC LIMIT 1"
    );
    
    let nextNumber = 1; // Commencer à 1 par défaut
    
    if (result.rows.length > 0) {
      const lastId = result.rows[0].id;
      // Extraire le numéro de LAMP0001 → 1
      const lastNumber = parseInt(lastId.replace('LAMP', ''));
      nextNumber = lastNumber + 1;
    }
    
    // Formater avec zéros (LAMP0001, LAMP0002, etc.)
    return `LAMP${nextNumber.toString().padStart(4, '0')}`;
    
  } catch (error) {
    console.error('❌ Erreur génération ID:', error.message);
    // Fallback : utiliser timestamp
    return `LAMP${Date.now().toString().slice(-4)}`;
  }
}

// ========================================
// VARIABLES GLOBALES WEBSOCKET
// ========================================
let espClients = new Map();     // mac → { ws, lampId, token }
let androidClients = [];        // Tableau de WebSocket Android

// ========================================
// ROUTES HTTP/API
// ========================================
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Serveur Lampadaire IoT',
    endpoints: [
      'GET /api/lampadaires',
      'GET /api/lampadaire/:id',
      'POST /api/lampadaire/install',
      'PUT /api/lampadaire/:id',
      'DELETE /api/lampadaire/:id',
      'GET /health'
    ]
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    db: 'connected'
  });
});

// Liste tous les lampadaires
app.get('/api/lampadaires', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM lampadaires ORDER BY created_at DESC'
    );
    const lampadaires = result.rows.map(lamp => {
      const isConnected = espClients.has(lamp.mac);
      if (isConnected && lamp.status === 'OFF') {
        lamp.status = 'CONNECTED';
      } else if (!isConnected && lamp.status !== 'HORS_LIGNE') {
        lamp.status = 'HORS_LIGNE';
      }
      return lamp;
    });
    console.log(`✅ GET /api/lampadaires - ${lampadaires.length} lampadaires`);
    res.json(lampadaires);
  } catch (error) {
    console.error('❌ Erreur GET /api/lampadaires:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Détail d'un lampadaire
app.get('/api/lampadaire/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM lampadaires WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lampadaire non trouvé' });
    }
    const lamp = result.rows[0];
    const isConnected = espClients.has(lamp.mac);
    if (isConnected && lamp.status === 'OFF') {
      lamp.status = 'CONNECTED';
    } else if (!isConnected) {
      lamp.status = 'HORS_LIGNE';
    }
    res.json(lamp);
  } catch (error) {
    console.error('❌ Erreur GET /api/lampadaire/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ Installation d'un nouveau lampadaire (CORRIGÉ)
app.post('/api/lampadaire/install', async (req, res) => {
  try {
    const { mac, latitude, longitude, altitude, lieu_installation, date_installation } = req.body;
    if (!mac || !latitude || !longitude) {
      return res.status(400).json({
        error: 'Données manquantes',
        required: ['mac', 'latitude', 'longitude']
      });
    }
    const existing = await pool.query('SELECT id FROM lampadaires WHERE mac = $1', [mac]);
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'MAC déjà enregistrée',
        id: existing.rows[0].id
      });
    }
    
    // ✅ GÉNÉRER ID SÉQUENTIEL (ASYNC)
    const lampId = await generateLampId();
    const token = generateToken();
    
    await pool.query(
      `INSERT INTO lampadaires 
       (id, mac, latitude, longitude, altitude, lieu_installation, date_installation, token, status, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OFF', NOW())`,
      [lampId, mac, latitude, longitude, altitude || 0.0, lieu_installation || 'Non spécifié', date_installation, token]
    );
    console.log(`✅ Lampadaire installé: ${lampId} (MAC: ${mac})`);
    broadcastToAndroid({
      type: 'lamp_added',
      lamp: { id: lampId, mac, latitude, longitude, status: 'OFF' }
    });
    res.status(200).json({
      success: true,
      message: 'Lampadaire installé avec succès',
      id: lampId,
      token: token
    });
  } catch (error) {
    console.error('❌ Erreur POST /api/lampadaire/install:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Mise à jour d'un lampadaire
app.put('/api/lampadaire/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { latitude, longitude, altitude, lieu_installation, status } = req.body;
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (latitude !== undefined) { updates.push(`latitude = $${paramIndex++}`); values.push(latitude); }
    if (longitude !== undefined) { updates.push(`longitude = $${paramIndex++}`); values.push(longitude); }
    if (altitude !== undefined) { updates.push(`altitude = $${paramIndex++}`); values.push(altitude); }
    if (lieu_installation !== undefined) { updates.push(`lieu_installation = $${paramIndex++}`); values.push(lieu_installation); }
    if (status !== undefined) { updates.push(`status = $${paramIndex++}`); values.push(status); }

    updates.push(`last_update = NOW()`);
    if (updates.length === 1) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    }

    values.push(id);
    const query = `
      UPDATE lampadaires 
      SET ${updates.join(', ')} 
      WHERE id = $${paramIndex} 
      RETURNING *
    `;
    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lampadaire non trouvé' });
    }
    broadcastToAndroid({ type: 'lamp_updated', lamp: result.rows[0] });
    res.json({ success: true, lamp: result.rows[0] });
  } catch (error) {
    console.error('❌ Erreur PUT /api/lampadaire/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Suppression d'un lampadaire
app.delete('/api/lampadaire/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM lampadaires WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lampadaire non trouvé' });
    }
    broadcastToAndroid({ type: 'lamp_deleted', lampId: id });
    res.json({ success: true, message: 'Lampadaire supprimé' });
  } catch (error) {
    console.error('❌ Erreur DELETE /api/lampadaire/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ========================================
// WEBSOCKET SERVER
// ========================================
const PORT = parseInt(process.env.PORT || 10000);
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`🔌 Nouvelle connexion WebSocket depuis ${clientIp}`);

  // Ping toutes les 30 secondes
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      switch (data.type) {
        case 'register':
          await handleRegister(ws, data);
          break;
        case 'esp_data':
          await handleEspData(data);
          break;
        case 'command':
          handleCommand(data);
          break;
        case 'interval_confirm':
          broadcastToAndroid(data);
          break;
        case 'alert':
          console.log(`🚨 Alerte reçue: ${data.titre} - ${data.message}`);
          console.log(`📍 Lampadaire: ${data.idLampadaire}`);
          console.log(`💡 État: ${data.lampState}, LDR: ${data.ldr || 'N/A'}`);
          
          const alertPayload = {
            type: 'alert',
            idLampadaire: data.idLampadaire,
            titre: data.titre,
            message: data.message,
            lampState: data.lampState,
            timestamp: data.timestamp || new Date().toISOString(),
            ldr: data.ldr || 0,
            latitude: data.latitude || 0,
            longitude: data.longitude || 0,
            lieu: data.lieu || 'Unknown'
          };
          
          broadcastToAndroid(alertPayload);
          break;
        default:
          console.log(`⚠️ Type de message inconnu: ${data.type}`);
      }
    } catch (error) {
      console.error('❌ Erreur parsing message WebSocket:', error.message);
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    console.log(`🔌 Déconnexion WebSocket: ${clientIp}`);

    // Vérifier si c'est un ESP32
    for (const [mac, client] of espClients.entries()) {
      if (client.ws === ws) {
        console.log(`📡 ESP32 déconnecté: ${mac}`);
        pool.query(
          'UPDATE lampadaires SET status = $1, signal = $2, last_update = NOW() WHERE mac = $3',
          ['HORS_LIGNE', 0, mac]
        ).then(() => {
          broadcastToAndroid({
            type: 'lamp_disconnected',
            lampId: client.lampId,
            mac: mac,
            status: 'HORS_LIGNE',
            signal: 0,
            timestamp: new Date().toISOString()
          });
        }).catch(err => console.error('❌ Erreur mise à jour déconnexion:', err.message));
        espClients.delete(mac);
        break;
      }
    }
    // Retirer des clients Android
    androidClients = androidClients.filter(c => c !== ws);
  });

  ws.on('error', (error) => {
    console.error('❌ Erreur WebSocket:', error.message);
  });
});

// ========================================
// HANDLERS WEBSOCKET
// ========================================
async function handleRegister(ws, data) {
  if (data.clientType === 'android') {
    androidClients.push(ws);
    ws.send(JSON.stringify({ type: 'welcome', message: 'Android connecté' }));
    console.log('📱 Client Android enregistré');
    return;
  }

  if (data.clientType === 'esp32' && data.mac) {
    try {
      const result = await pool.query(
        'SELECT id, token, status, latitude, longitude, lieu_installation FROM lampadaires WHERE mac = $1',
        [data.mac]
      );
      if (result.rows.length > 0) {
        const lamp = result.rows[0];
        espClients.set(data.mac, { ws, lampId: lamp.id, token: lamp.token });
        await pool.query(
          'UPDATE lampadaires SET status = $1, signal = $2, last_update = NOW() WHERE mac = $3',
          ['CONNECTED', -50, data.mac]
        );
        
        // ✅ ENVOYER LES COORDONNÉES À L'ESP32
        ws.send(JSON.stringify({
          type: 'welcome',
          lampId: lamp.id,
          token: lamp.token,
          status: 'CONNECTED',
          latitude: lamp.latitude,        
          longitude: lamp.longitude,      
          lieu: lamp.lieu_installation    
        }));
        
        broadcastToAndroid({
          type: 'lamp_connected',
          lampId: lamp.id,
          mac: data.mac,
          status: 'CONNECTED',
          signal: -50
        });
        console.log(`✅ ESP32 enregistré: ${data.mac} → ${lamp.id}`);
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'MAC non enregistrée' }));
        ws.close();
        console.log(`❌ ESP32 refusé: MAC ${data.mac} inconnu`);
      }
    } catch (error) {
      console.error('❌ Erreur handleRegister:', error.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Erreur serveur' }));
    }
  }
}

async function handleEspData(data) {
  try {
    const { idLampadaire, state, signal = -50 } = data;
    await pool.query(
      'UPDATE lampadaires SET status = $1, signal = $2, last_update = NOW() WHERE id = $3',
      [state, signal, idLampadaire]
    );
    console.log(`📊 Données ESP: ${idLampadaire} → ${state} (${signal} dBm)`);
    broadcastToAndroid(data);
  } catch (error) {
    console.error('❌ Erreur handleEspData:', error.message);
  }
}

function handleCommand(data) {
  const targetLampId = data.idLampadaire;
  if (targetLampId && targetLampId !== "0") {
    let sent = false;
    for (const [mac, client] of espClients.entries()) {
      if (String(client.lampId) === String(targetLampId) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(data));
        console.log(`📤 Commande "${data.command}" → ${targetLampId} (MAC: ${mac})`);
        sent = true;
        break;
      }
    }
    if (!sent) console.warn(`⚠️ Lampadaire ${targetLampId} non connecté`);
  } else {
    let count = 0;
    for (const [mac, client] of espClients.entries()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(data));
        count++;
      }
    }
    console.log(`📤 Commande "${data.command}" envoyée à ${count} lampadaires`);
  }
  broadcastToAndroid({
    type: 'command_sent',
    command: data.command,
    lampId: targetLampId
  });
}

function broadcastToAndroid(data) {
  const payload = JSON.stringify(data);
  console.log(`📡 Broadcasting à ${androidClients.length} clients Android`);
  console.log(`📦 Payload: ${payload}`);
  
  androidClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      console.log('✅ Message envoyé à un client Android');
    }
  });
}

// ========================================
// DÉMARRAGE SERVEUR
// ========================================
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`🔌 WebSocket actif sur ws://0.0.0.0:${PORT}`);
  const connected = await testConnection();
  if (connected) {
    await initDatabase();
  } else {
    console.error('❌ Impossible d\'initialiser la base de données');
  }
});

// ========================================
// GESTION DES ERREURS GLOBALES
// ========================================
process.on('uncaughtException', (error) => {
  console.error('❌ Erreur non gérée (uncaughtException):', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejetée (unhandledRejection):', reason);
});
