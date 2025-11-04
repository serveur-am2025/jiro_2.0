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
const http = require('http');

const app = express();
app.use(express.json());
app.use(cors());

// ========================================
// 🗄️ CONFIGURATION POSTGRESQL (NEON COMPATIBLE)
// ========================================
const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: { rejectUnauthorized: false }
};
const pool = new Pool(poolConfig);

// Test de connexion SANS BLOQUER
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

pool.on('error', (err) => console.error('❌ Erreur PostgreSQL:', err.message));

// ========================================
// 🛠️ INITIALISATION BASE DE DONNÉES (ASYNC NON-BLOQUANTE)
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
   
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mac ON lampadaires(mac)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_status ON lampadaires(status)`);
    await client.query('COMMIT');
    console.log('✅ Base PostgreSQL initialisée');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erreur initialisation base:', error.message);
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
// 📡 ROUTES HTTP/API
// ========================================
// ✅ Route racine
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Serveur Lampadaire IoT',
    endpoints: [
      'GET /api/lampadaires',
      'POST /api/lampadaire/install',
      'GET /health'
    ]
  });
});

// ✅ Health check (IMPORTANT pour Render)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString()
  });
});

// ✅ GET /api/lampadaires
app.get('/api/lampadaires', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM lampadaires ORDER BY created_at DESC'
    );
    console.log(`📊 GET /api/lampadaires - ${result.rows.length} résultats`);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erreur GET /api/lampadaires:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ GET /api/lampadaire/:id
app.get('/api/lampadaire/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM lampadaires WHERE id = $1', [id]);
   
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lampadaire non trouvé' });
    }
   
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erreur GET /api/lampadaire/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ POST /api/lampadaire/install
app.post('/api/lampadaire/install', async (req, res) => {
  try {
    const { mac, latitude, longitude, altitude, lieu_installation, date_installation } = req.body;
    if (!mac || !latitude || !longitude) {
      return res.status(400).json({
        error: 'Données manquantes',
        required: ['mac', 'latitude', 'longitude']
      });
    }

    // Vérifier si MAC existe
    const existing = await pool.query('SELECT id FROM lampadaires WHERE mac = $1', [mac]);
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'MAC déjà enregistrée',
        id: existing.rows[0].id
      });
    }

    const lampId = generateLampId();
    const token = generateToken();

    await pool.query(
      `INSERT INTO lampadaires
       (id, mac, latitude, longitude, altitude, lieu_installation, date_installation, token, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OFF', NOW())`,
      [lampId, mac, latitude, longitude, altitude || 0.0, lieu_installation || 'Non spécifié', date_installation, token]
    );

    console.log(`✅ Lampadaire installé: ${lampId}`);
    broadcastToAndroid({
      type: 'lamp_added',
      lamp: { id: lampId, mac, latitude, longitude, status: 'OFF' }
    });

    res.status(200).json({
      success: true,
      message: 'Lampadaire installé',
      id: lampId,
      token: token
    });
  } catch (error) {
    console.error('❌ Erreur POST /api/lampadaire/install:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ PUT /api/lampadaire/:id - CORRIGÉ & DYNAMIQUE
app.put('/api/lampadaire/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { latitude, longitude, altitude, lieu_installation, status } = req.body;

    // Construction dynamique des champs à mettre à jour
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (latitude !== undefined) {
      updates.push(`latitude = $${paramIndex++}`);
      values.push(latitude);
    }
    if (longitude !== undefined) {
      updates.push(`longitude = $${paramIndex++}`);
      values.push(longitude);
    }
    if (altitude !== undefined) {
      updates.push(`altitude = $${paramIndex++}`);
      values.push(altitude);
    }
    if (lieu_installation !== undefined) {
      updates.push(`lieu_installation = $${paramIndex++}`);
      values.push(lieu_installation);
    }
    if (status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(status);
    }

    // Toujours mettre à jour last_update
    updates.push(`last_update = NOW()`);

    // Si aucun champ à mettre à jour → erreur
    if (updates.length === 1) { // seulement last_update
      return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    }

    // Ajouter l'ID pour le WHERE
    values.push(id);
    const query = `
      UPDATE lampadaires
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    console.log('📝 Query PUT:', query);
    console.log('📝 Values:', values);

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lampadaire non trouvé' });
    }

    // Notifier Android
    broadcastToAndroid({ type: 'lamp_updated', lamp: result.rows[0] });

    res.json({ success: true, lamp: result.rows[0] });
  } catch (error) {
    console.error('❌ Erreur PUT /api/lampadaire/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ DELETE /api/lampadaire/:id
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
// 🌐 WEBSOCKET SERVER (SUR LE MÊME PORT HTTP)
// ========================================
const PORT = parseInt(process.env.PORT || 10000);
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let espClients = new Map();
let androidClients = [];

wss.on('connection', (ws, req) => {
  console.log(`📡 WebSocket connecté: ${req.socket.remoteAddress}`);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      switch (data.type) {
        case 'register': await handleRegister(ws, data); break;
        case 'esp_data': await handleEspData(data); break;
        case 'command': handleCommand(data); break;
        case 'interval_confirm': broadcastToAndroid(data); break;
        default: console.log(`⚠️ Type inconnu: ${data.type}`);
      }
    } catch (error) {
      console.error('❌ Erreur WebSocket:', error.message);
    }
  });

  ws.on('close', () => {
    for (const [mac, client] of espClients.entries()) {
      if (client.ws === ws) {
        espClients.delete(mac);
        break;
      }
    }
    androidClients = androidClients.filter(c => c !== ws);
  });

  ws.on('error', (error) => console.error('❌ Erreur WebSocket:', error.message));

  // Ping pour garder la connexion vivante
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
});

// ========================================
// 📡 HANDLERS WEBSOCKET
// ========================================
async function handleRegister(ws, data) {
  if (data.clientType === 'android') {
    androidClients.push(ws);
    ws.send(JSON.stringify({ type: 'welcome', message: 'Android connecté' }));
  } else if (data.clientType === 'esp32' && data.mac) {
    try {
      const result = await pool.query(
        'SELECT id, token, status FROM lampadaires WHERE mac = $1',
        [data.mac]
      );
      if (result.rows.length > 0) {
        const lamp = result.rows[0];
        espClients.set(data.mac, { ws, lampId: lamp.id, token: lamp.token });
        ws.send(JSON.stringify({
          type: 'welcome',
          lampId: lamp.id,
          token: lamp.token,
          status: lamp.status
        }));
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'MAC non enregistrée'
        }));
        ws.close();
      }
    } catch (error) {
      console.error('❌ Erreur register:', error.message);
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
  } catch (error) {
    console.error('❌ Erreur esp_data:', error.message);
  }
}

function handleCommand(data) {
  const targetLampId = data.idLampadaire;
  
  if (targetLampId && targetLampId !== "0") {
    // ✅ Commande pour un lampadaire spécifique
    let sent = false;
    
    for (const [mac, client] of espClients.entries()) {
      // ✅ Convertir en String pour comparer
      if (String(client.lampId) === String(targetLampId) && 
          client.ws.readyState === WebSocket.OPEN) {
        
        client.ws.send(JSON.stringify(data));
        console.log(`✅ Commande ${data.command} envoyée à LAMP${targetLampId} (MAC: ${mac})`);
        sent = true;
        break;
      }
    }
    
    if (!sent) {
      console.warn(`⚠️ Lampadaire LAMP${targetLampId} non connecté`);
    }
  } else {
    // ✅ Commande pour TOUS les lampadaires
    let count = 0;
    for (const [mac, client] of espClients.entries()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(data));
        count++;
      }
    }
    console.log(`✅ Commande ${data.command} envoyée à ${count} lampadaires`);
  }
  
  broadcastToAndroid({ 
    type: 'command_sent', 
    command: data.command,
    lampId: targetLampId 
  });
}

function broadcastToAndroid(data) {
  androidClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  });
}

// ========================================
// 🚀 DÉMARRAGE SERVEUR (NON-BLOQUANT)
// ========================================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📡 WebSocket actif sur le même port`);

  // Initialiser DB en arrière-plan
  testConnection().then(connected => {
    if (connected) {
      initDatabase();
    }
  });
});

// Gestion des erreurs non gérées
process.on('uncaughtException', (error) => {
  console.error('❌ Erreur non gérée:', error);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejetée:', reason);
});
