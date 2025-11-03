// ========================================
// 🌐 SERVEUR IoT LAMPADAIRES - Render + PostgreSQL
// Node.js + Express + PostgreSQL + WebSocket
// Déploiement: GitHub → Render (Gratuit)
// ========================================
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const WebSocket = require('ws');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ========================================
// 🗄️ CONFIGURATION POSTGRESQL (NEON COMPATIBLE)
// ========================================
const isProduction = process.env.NODE_ENV === 'production';

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

// SSL uniquement en production (Render)
poolConfig.ssl = { rejectUnauthorized: false };

const pool = new Pool(poolConfig);

// Test de connexion avec retry
async function testConnection() {
  let retries = 3;
  while (retries > 0) {
    try {
      const client = await pool.connect();
      console.log('✅ PostgreSQL connecté à Neon');
      client.release();
      return true;
    } catch (error) {
      console.error(`❌ Tentative de connexion échouée (${retries} restantes):`, error.message);
      retries--;
      if (retries > 0) await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  throw new Error('Impossible de se connecter à PostgreSQL après 3 tentatives');
}

pool.on('error', (err) => console.error('❌ Erreur inattendue PostgreSQL:', err.message));

// ========================================
// 🛠️ INITIALISATION BASE DE DONNÉES
// ========================================
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lampadaires
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mac ON lampadaires(mac)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_status ON lampadaires(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_location ON lampadaires(latitude, longitude)`);

    await client.query('COMMIT');
    console.log('✅ Base PostgreSQL initialisée avec succès');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erreur initialisation base:', error);
    throw error;
  } finally {
    client.release();
  }
}

// ========================================
// 🔐 GÉNÉRATION TOKEN / ID
// ========================================
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}
function generateLampId() {
  const num = Math.floor(Math.random() * 9999) + 1;
  return `LAMP${num.toString().padStart(4, '0')}`;
}

// ========================================
// 🌐 WEBSOCKET SERVER
// ========================================
const WS_PORT = parseInt(process.env.WS_PORT || 10000);
const wss = new WebSocket.Server({ port: WS_PORT });

let espClients = new Map();
let androidClients = [];

wss.on('connection', (ws, req) => {
  console.log(`📡 Nouvelle connexion WebSocket: ${req.socket.remoteAddress}`);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      switch (data.type) {
        case 'register': await handleRegister(ws, data); break;
        case 'esp_data': await handleEspData(data); break;
        case 'command': handleCommand(data); break;
        case 'alert': console.log('⚠️ Alert handler supprimé.'); break;
        case 'interval_confirm': broadcastToAndroid(data); break;
        default: console.log(`⚠️ Type inconnu: ${data.type}`);
      }
    } catch (error) {
      console.error('❌ Erreur parsing WebSocket:', error.message);
    }
  });

  ws.on('close', () => {
    for (const [mac, client] of espClients.entries()) {
      if (client.ws === ws) {
        console.log(`🔌 ESP32 déconnecté: ${mac}`);
        espClients.delete(mac);
        break;
      }
    }
    androidClients = androidClients.filter(c => c !== ws);
  });

  ws.on('error', (error) => console.error('❌ Erreur WebSocket:', error.message));

  // Ping automatique
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    else clearInterval(pingInterval);
  }, parseInt(process.env.PING_INTERVAL_MS || 30000));
});

// ========================================
// 📡 HANDLERS WEBSOCKET
// ========================================
async function handleRegister(ws, data) {
  if (data.clientType === 'android') {
    androidClients.push(ws);
    ws.send(JSON.stringify({ type: 'welcome', message: 'Android connecté' }));
    console.log('📱 Android enregistré');
  } else if (data.clientType === 'esp32' && data.mac) {
    try {
      console.log(`🔍 Recherche MAC: ${data.mac}`);
      const result = await pool.query(
        'SELECT id, token, status FROM lampadaires WHERE mac = $1',
        [data.mac]
      );

      if (result.rows.length > 0) {
        const lamp = result.rows[0];
        espClients.set(data.mac, { ws, lampId: lamp.id, token: lamp.token });
        ws.send(JSON.stringify({ type: 'welcome', lampId: lamp.id, token: lamp.token, status: lamp.status }));
        console.log(`✅ ESP32 ${lamp.id} enregistré (MAC: ${data.mac})`);
      } else {
        console.log(`❌ MAC ${data.mac} non trouvée`);
        ws.send(JSON.stringify({ type: 'error', message: 'MAC non enregistrée. Installer via app Android.' }));
        ws.close();
      }
    } catch (error) {
      console.error('❌ Erreur register ESP:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Erreur serveur: ' + error.message }));
    }
  }
}

async function handleEspData(data) {
  try {
    await pool.query(
      'UPDATE lampadaires SET status = $1, last_update = NOW() WHERE id = $2',
      [data.state, data.idLampadaire]
    );
    broadcastToAndroid(data);
    console.log(`📊 Données ESP: Lamp ${data.idLampadaire} → ${data.state}`);
  } catch (error) {
    console.error('❌ Erreur esp_data:', error);
  }
}

function handleCommand(data) {
  console.log(`⚡ Commande: ${data.command} → Lamp ${data.idLampadaire || 'TOUS'}`);
  if (data.idLampadaire) {
    for (const [mac, client] of espClients.entries()) {
      if (client.lampId === data.idLampadaire && client.ws.readyState === WebSocket.OPEN)
        client.ws.send(JSON.stringify(data));
    }
  } else {
    for (const [mac, client] of espClients.entries()) {
      if (client.ws.readyState === WebSocket.OPEN)
        client.ws.send(JSON.stringify(data));
    }
  }
  broadcastToAndroid({ type: 'command_sent', command: data.command, lampId: data.idLampadaire });
}

// ========================================
// 🔄 BROADCAST VERS ANDROID
// ========================================
function broadcastToAndroid(data) {
  androidClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  });
}

// ========================================
// 🚀 DÉMARRAGE
// ========================================
testConnection()
  .then(() => initDatabase())
  .then(() => {
    const PORT = parseInt(process.env.PORT || 3000);
    app.listen(PORT, () => {
      console.log(`🚀 Serveur HTTP démarré sur le port ${PORT}`);
      console.log(`🔌 WebSocket sur le port ${WS_PORT}`);
      console.log(`🌍 Mode: ${isProduction ? 'PRODUCTION' : 'DÉVELOPPEMENT'}`);
    });
  })
  .catch(error => {
    console.error('❌ Erreur fatale au démarrage:', error);
    process.exit(1);
  });