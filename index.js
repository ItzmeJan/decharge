// Full expanded server file with:
// - No nonce cleanup (preserves nonces for delayed Phantom signing)
// - Robust session handling without circular JSON
// - Reward token transfers using @solana/spl-token createTransferInstruction
// - Uses provided token & server keypair (devnet)
// - Logs reward transfer signatures into history

const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Transaction, Keypair } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createTransferInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default;
const fs = require('fs').promises;
const path = require('path');

const { getOrCreateAssociatedTokenAccount } = require('@solana/spl-token');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// -----------------------------
// Configuration (from your provided token info)
// -----------------------------
const TOKEN_CONFIG = {
  tokenMint: 'BbJz98qeUBLAkH5TSQMWE8TsFgEpCijQuu7TvCbndc4A',
  serverPublicKey: 'C6rNnPKxXSTSWxdMH3ZWmZG7ZwXhPurPbUkGuyvtDzT4',
  serverTokenAccount: 'G9fXJnoKArRrqRDKmJcxXbsoZSi5VKyryfTf4a93htJh',
  decimals: 9,
  network: 'devnet',
  rpc: 'https://api.devnet.solana.com'
};

// If you prefer to load keypair from a file, set SERVER_KEYPAIR_PATH.
// Otherwise, this example uses the secret array you provided (paste below).
const SERVER_KEYPAIR_PATH = process.env.SERVER_KEYPAIR_PATH || null; // e.g. './server-keypair.json'

// Paste your server secret array here (the one you gave):
const SERVER_SECRET_ARRAY = [230,247,130,247,39,17,114,52,218,116,123,164,16,238,189,205,42,45,68,34,217,66,241,51,31,23,16,159,44,114,111,216,164,240,74,19,115,127,53,201,103,122,10,245,128,81,56,216,134,207,81,77,96,83,102,147,113,156,46,84,207,14,202,27];

const PORT = process.env.PORT || 3000;
const connection = new Connection(TOKEN_CONFIG.rpc, 'confirmed');
let serverKeypair;

// -----------------------------
// DB paths and in-memory stores
// -----------------------------
const DB_PATH = './db';
const NONCES_FILE = path.join(DB_PATH, 'nonces.json');
const SESSIONS_FILE = path.join(DB_PATH, 'sessions.json');
const HISTORY_FILE = path.join(DB_PATH, 'history.json');

let nonces = {};      // { nonce: { timestamp, used } }
let sessions = {};    // { sessionId: { ...sessionData } }
let history = [];     // array of completed session objects (cleaned)

// Runtime-only map for interval handles (not serialized)
const runningSimulations = {}; // { sessionId: IntervalObject }

// -----------------------------
// Helpers: cleaning, saving, loading
// -----------------------------
function cleanSessionForJSON(session) {
  if (!session) return session;
  const { _intervalHandle, intervalId, __private, ...rest } = session;
  return rest;
}

async function saveNonces() {
  await fs.mkdir(DB_PATH, { recursive: true });
  await fs.writeFile(NONCES_FILE, JSON.stringify(nonces, null, 2));
}

async function saveSessions() {
  await fs.mkdir(DB_PATH, { recursive: true });
  const cleaned = Object.fromEntries(
    Object.entries(sessions).map(([id, s]) => [id, cleanSessionForJSON(s)])
  );
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(cleaned, null, 2));
}

async function saveHistory() {
  await fs.mkdir(DB_PATH, { recursive: true });
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
}

async function loadDB() {
  await fs.mkdir(DB_PATH, { recursive: true });
  try { nonces = JSON.parse(await fs.readFile(NONCES_FILE, 'utf8')); } catch (e) { nonces = {}; }
  try { sessions = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8')); } catch (e) { sessions = {}; }
  try { history = JSON.parse(await fs.readFile(HISTORY_FILE, 'utf8')); } catch (e) { history = []; }
}

function generateNonce() {
  return bs58.encode(nacl.randomBytes(32));
}

function verifySignature(publicKey, signature, nonce) {
  try {
    const pubKey = new PublicKey(publicKey);
    const signatureUint8 = bs58.decode(signature);
    const messageUint8 = new TextEncoder().encode(nonce);
    return nacl.sign.detached.verify(messageUint8, signatureUint8, pubKey.toBytes());
  } catch (e) {
    console.error('Signature verification error:', e);
    return false;
  }
}

// -----------------------------
// Load server keypair (from path or secret array)
// -----------------------------
async function loadServerKeypair() {
  try {
    if (SERVER_KEYPAIR_PATH) {
      const keypairData = JSON.parse(await fs.readFile(SERVER_KEYPAIR_PATH, 'utf8'));
      serverKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
    } else {
      serverKeypair = Keypair.fromSecretKey(new Uint8Array(SERVER_SECRET_ARRAY));
    }
    console.log('Server public key:', serverKeypair.publicKey.toString());
    if (serverKeypair.publicKey.toString() !== TOKEN_CONFIG.serverPublicKey) {
      console.warn('Warning: provided server keypair public key does not match serverPublicKey in token config');
    }
  } catch (e) {
    console.error('Failed to load server keypair:', e);
    process.exit(1);
  }
}

// -----------------------------
// Stations (same as your original list) - shortened here for brevity
// You can paste your full stations block if needed.
// -----------------------------
const stations = {
  "charge_points": [
    {
      "code": "BERSTD34",
      "name": "3.3kW Charger",
      "no_of_connectors": 2,
      "location": {
        "city": "Bengaluru",
        "address": "12 MG Road, Bengaluru, KA",
        "latitude": 12.9716,
        "longitude": 77.5946
      },
      "status": "active",
      "pricing": {
        "time_based": {
          "rate": 2.0,
          "unit": "INR_per_min"
        },
        "energy_based": {
          "rate": 19.0,
          "unit": "INR_per_kWh"
        }
      },
      "connectors": [
        {
          "id": "C1",
          "type": "Type-2 AC",
          "power_kw": 3.3,
          "status": "available"
        },
        {
          "id": "C2",
          "type": "Type-2 AC",
          "power_kw": 3.3,
          "status": "occupied"
        }
      ]
    },
    {
      "code": "DELHINR12",
      "name": "7.4kW Charger",
      "no_of_connectors": 1,
      "location": {
        "city": "New Delhi",
        "address": "Sector 18, Dwarka, New Delhi, DL",
        "latitude": 28.6139,
        "longitude": 77.2090
      },
      "status": "active",
      "pricing": {
        "time_based": {
          "rate": 2.5,
          "unit": "INR_per_min"
        },
        "energy_based": {
          "rate": 20.0,
          "unit": "INR_per_kWh"
        }
      },
      "connectors": [
        {
          "id": "C1",
          "type": "CCS2 DC",
          "power_kw": 7.4,
          "status": "available"
        }
      ]
    },
    {
      "code": "MUMBAI45",
      "name": "11kW Charger",
      "no_of_connectors": 2,
      "location": {
        "city": "Mumbai",
        "address": "Andheri East, Mumbai, MH",
        "latitude": 19.0760,
        "longitude": 72.8777
      },
      "status": "maintenance",
      "pricing": {
        "time_based": {
          "rate": 1.5,
          "unit": "INR_per_min"
        },
        "energy_based": {
          "rate": 17.0,
          "unit": "INR_per_kWh"
        }
      },
      "connectors": [
        {
          "id": "C1",
          "type": "Type-2 AC",
          "power_kw": 11,
          "status": "maintenance"
        },
        {
          "id": "C2",
          "type": "Type-2 AC",
          "power_kw": 11,
          "status": "maintenance"
        }
      ]
    },
    {
      "code": "CHENNAI88",
      "name": "22kW Dual Port Charger",
      "no_of_connectors": 2,
      "location": {
        "city": "Chennai",
        "address": "OMR Road, Chennai, TN",
        "latitude": 13.0827,
        "longitude": 80.2707
      },
      "status": "active",
      "pricing": {
        "time_based": {
          "rate": 3.0,
          "unit": "INR_per_min"
        },
        "energy_based": {
          "rate": 21.5,
          "unit": "INR_per_kWh"
        }
      },
      "connectors": [
        {
          "id": "C1",
          "type": "CCS2 DC",
          "power_kw": 22,
          "status": "available"
        },
        {
          "id": "C2",
          "type": "CHAdeMO DC",
          "power_kw": 22,
          "status": "occupied"
        }
      ]
    },
    {
      "code": "HYDPLX09",
      "name": "DC Fast Charger 30kW",
      "no_of_connectors": 1,
      "location": {
        "city": "Hyderabad",
        "address": "Banjara Hills, Hyderabad, TS",
        "latitude": 17.3850,
        "longitude": 78.4867
      },
      "status": "offline",
      "pricing": {
        "time_based": {
          "rate": 3.5,
          "unit": "INR_per_min"
        },
        "energy_based": {
          "rate": 22.0,
          "unit": "INR_per_kWh"
        }
      },
      "connectors": [
        {
          "id": "C1",
          "type": "CCS2 DC",
          "power_kw": 30,
          "status": "offline"
        }
      ]
    }
  ]
}

// -----------------------------
// Charging simulation
// -----------------------------
function startChargingSimulation(sessionId) {
  const session = sessions[sessionId];
  if (!session) return;
  if (runningSimulations[sessionId]) return; // already running

  const station = stations.charge_points.find(s => s.code === session.stationCode);
  const connector = station?.connectors.find(c => c.id === session.connectorId) || {};
  const powerKw = connector.power_kw || session.powerKw || 3.3;
  const updateIntervalSeconds = 10;

  const interval = setInterval(async () => {
    const s = sessions[sessionId];
    if (!s || s.status !== 'charging') {
      clearInterval(interval);
      delete runningSimulations[sessionId];
      return;
    }

    const baseIncrement = (powerKw / 3600) * updateIntervalSeconds; // kWh per interval
    const variation = 0.9 + Math.random() * 0.2;
    s.kwhUsed = (s.kwhUsed || 0) + baseIncrement * variation;
    s.timeElapsedSeconds = Math.floor((Date.now() - s.startTime) / 1000);

    try { await saveSessions(); } catch (e) { console.error('Error saving sessions during sim:', e); }
  }, updateIntervalSeconds * 1000);

  runningSimulations[sessionId] = interval;
}

function stopChargingSimulation(sessionId) {
  const interval = runningSimulations[sessionId];
  if (interval) {
    clearInterval(interval);
    delete runningSimulations[sessionId];
  }
}

// -----------------------------
// Reward sending (uses SPL token transfer instruction)
// -----------------------------
async function sendRewardTokens(recipientPublicKeyString, amountTokens) {
  // amountTokens is token amount in UI units (not decimals applied)
  if (!serverKeypair) throw new Error('Server keypair not loaded');
  if (TOKEN_CONFIG.tokenMint === 'YOUR_TOKEN_MINT_ADDRESS') {
    console.log(`Token mint not configured. Would send ${amountTokens} tokens to ${recipientPublicKeyString}`);
    return null;
  }

  if (amountTokens <= 0) {
    return null; // nothing to send
  }

  const mintPubkey = new PublicKey(TOKEN_CONFIG.tokenMint);
  const recipientPubkey = new PublicKey(recipientPublicKeyString);

  // Get or create recipient ATA automatically
  const recipientATA = await getOrCreateAssociatedTokenAccount(
    connection,
    serverKeypair,       // payer
    mintPubkey,          // token mint
    recipientPubkey      // owner
  );

  // Server ATA
  const sourceATA = await getOrCreateAssociatedTokenAccount(
    connection,
    serverKeypair,
    mintPubkey,
    serverKeypair.publicKey
  );

  // amount as integer using decimals
  const decimals = Number(TOKEN_CONFIG.decimals || 9);
  const amountBigInt = BigInt(amountTokens) * (BigInt(10) ** BigInt(decimals));

  const tx = new Transaction().add(
    createTransferInstruction(
      sourceATA.address,
      recipientATA.address,
      serverKeypair.publicKey,
      amountBigInt,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const signature = await connection.sendTransaction(tx, [serverKeypair]);
  await connection.confirmTransaction(signature, 'confirmed');

  console.log(`Sent ${amountTokens} tokens to ${recipientPublicKeyString}, tx: ${signature}`);
  return signature; // return signature for history logging
}


// -----------------------------
// Finalize session (common logic for user end or admin stop)
// -----------------------------
async function finalizeSession(sessionId, { stoppedByAdmin = false, txSignature = null } = {}) {
  const session = sessions[sessionId];
  if (!session) return null;

  // Stop simulation
  stopChargingSimulation(sessionId);

  // Ensure time elapsed recorded
  session.timeElapsedSeconds = session.timeElapsedSeconds || Math.floor((Date.now() - (session.startTime || Date.now())) / 1000);

  // Calculate costs
  const timeMinutes = session.timeElapsedSeconds / 60;
  const timeCost = (session.pricing?.time_based?.rate || 0) * timeMinutes;
  const energyCost = (session.kwhUsed || 0) * (session.pricing?.energy_based?.rate || 0);
  session.totalCost = timeCost + energyCost;
  session.totalCostSOL = session.totalCost / 100; // demo conversion

  session.status = stoppedByAdmin ? 'stopped_by_admin' : 'completed';
  session.endTime = Date.now();
  if (txSignature) session.paymentTx = txSignature;

  // Rewards: 1 token per whole kWh
  const rewardAmount = Math.max(0, Math.floor(session.kwhUsed || 0));
  session.rewardTokens = rewardAmount;

  // Attempt to send tokens and record signature
  try {
    const rewardTxSig = await sendRewardTokens(session.publicKey, rewardAmount);
    session.rewardSent = !!rewardTxSig;
    session.rewardTx = rewardTxSig || null;
  } catch (e) {
    console.error('Failed to send reward tokens:', e);
    session.rewardSent = false;
    session.rewardError = e.message;
  }

  // Save a cleaned copy into history (including rewardTx)
  const histEntry = { ...cleanSessionForJSON(session), completedAt: new Date().toISOString() };
  history.push(histEntry);

  // persist sessions & history
  delete session._intervalHandle; // ensure no runtime-only props
  await saveSessions();
  await saveHistory();

  return cleanSessionForJSON(session);
}

// -----------------------------
// Routes
// -----------------------------
// Get nonce (do NOT auto-clean nonces; keep them until used)
app.get('/nonce', (req, res) => {
  const nonce = generateNonce();
  nonces[nonce] = { timestamp: Date.now(), used: false };
  saveNonces().catch(e => console.error('saveNonces error:', e));
  res.json({ nonce });
});

// Login verify
app.post('/loginVerify', (req, res) => {
  const { publicKey, signature, nonce } = req.body;
  if (!nonce || !nonces[nonce]) return res.status(400).json({ error: 'Nonce missing or unknown' });
  if (nonces[nonce].used) return res.status(400).json({ error: 'Nonce already used' });

  if (!verifySignature(publicKey, signature, nonce)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  nonces[nonce].used = true;
  saveNonces().catch(e => console.error('saveNonces error:', e));
  res.json({ success: true, publicKey });
});

// List stations (returns connector statuses considering active sessions)
app.get('/stations', (req, res) => {
  const stationsWithStatus = JSON.parse(JSON.stringify(stations));
  Object.values(sessions).forEach(s => {
    if (s.status === 'charging') {
      const st = stationsWithStatus.charge_points.find(x => x.code === s.stationCode);
      if (st) {
        const conn = st.connectors.find(c => c.id === s.connectorId);
        if (conn) conn.status = 'occupied';
      }
    }
  });
  res.json(stationsWithStatus);
});

// Start charge
app.post('/startCharge', async (req, res) => {
  try {
    const { publicKey, signature, nonce, stationCode, connectorId } = req.body;
    if (!nonce || !nonces[nonce] || nonces[nonce].used) return res.status(400).json({ error: 'Invalid or expired nonce' });
    if (!verifySignature(publicKey, signature, nonce)) return res.status(401).json({ error: 'Invalid signature' });

    // validate station & connector
    const station = stations.charge_points.find(s => s.code === stationCode);
    if (!station) return res.status(404).json({ error: 'Station not found' });
    if (station.status !== 'active') return res.status(400).json({ error: `Station is ${station.status}` });
    const connector = station.connectors.find(c => c.id === connectorId);
    if (!connector) return res.status(404).json({ error: 'Connector not found' });

    // check availability
    const colliding = Object.values(sessions).find(s => s.stationCode === stationCode && s.connectorId === connectorId && s.status === 'charging');
    if (colliding || connector.status === 'occupied' || connector.status === 'maintenance' || connector.status === 'offline') {
      return res.status(400).json({ error: 'Connector not available' });
    }

    const userActive = Object.values(sessions).find(s => s.publicKey === publicKey && s.status === 'charging');
    if (userActive) return res.status(400).json({ error: 'You already have an active charging session' });

    // mark nonce used
    nonces[nonce].used = true;
    await saveNonces();

    // create session
    const sessionId = `${Date.now()}_${publicKey.slice(0, 8)}`;
    sessions[sessionId] = {
      id: sessionId,
      publicKey,
      stationCode,
      connectorId,
      status: 'charging',
      kwhUsed: 0,
      timeElapsedSeconds: 0,
      startTime: Date.now(),
      pricing: station.pricing
    };

    await saveSessions();
    startChargingSimulation(sessionId);

    res.json({ success: true, sessionId, message: 'Charging session started' });
  } catch (e) {
    console.error('startCharge error:', e);
    res.status(500).json({ error: 'Server error', details: e.message });
  }
});

// Monitor sessions for a pubkey
app.get('/monitor', (req, res) => {
  const { pubkey } = req.query;
  if (!pubkey) return res.status(400).json({ error: 'Public key required' });
  const userSessions = Object.values(sessions).filter(s => s.publicKey === pubkey && s.status === 'charging');
  res.json({ sessions: userSessions.map(cleanSessionForJSON) });
});

// End charge (user)
app.post('/endCharge', async (req, res) => {
  try {
    const { sessionId, txSignature } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'charging') return res.status(400).json({ error: 'Session already ended' });

    // Optional: verify payment transaction on Solana (placeholder) -- implement if you need strict enforcement
    if (txSignature) {
      try {
        const tx = await connection.getTransaction(txSignature, { commitment: 'confirmed' });
        if (!tx) return res.status(400).json({ error: 'Payment transaction not found' });
        // In production inspect tx.meta/pre/post balances or parsed instructions to validate amount and recipient
      } catch (e) {
        return res.status(400).json({ error: 'Error fetching transaction', details: e.message });
      }
    }

    const finalized = await finalizeSession(sessionId, { stoppedByAdmin: false, txSignature });
    res.json({ success: true, session: finalized, message: 'Charging session completed' });
  } catch (e) {
    console.error('endCharge error:', e);
    res.status(500).json({ error: 'Server error', details: e.message });
  }
});

// History
app.get('/history', (req, res) => {
  const { pubkey } = req.query;
  if (!pubkey) return res.status(400).json({ error: 'Public key required' });
  const userHistory = history.filter(h => h.publicKey === pubkey);
  res.json({ history: userHistory });
});

// Admin routes (simple auth)
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin';

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) return res.json({ success: true });
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/admin/sessions', (req, res) => {
  res.json({ sessions: Object.values(sessions).map(cleanSessionForJSON) });
});

app.get('/admin/history', (req, res) => {
  res.json({ history });
});

app.post('/admin/stopSession', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'charging') return res.status(400).json({ error: 'Session not active' });

    const finalized = await finalizeSession(sessionId, { stoppedByAdmin: true });
    res.json({ success: true, session: finalized });
  } catch (e) {
    console.error('admin.stopSession error:', e);
    res.status(500).json({ error: 'Server error', details: e.message });
  }
});

// -----------------------------
// Init
// -----------------------------
(async function init() {
  try {
    await loadDB();
    await loadServerKeypair();

    // Resume any charging simulations that were active
    Object.entries(sessions).forEach(([id, s]) => {
      if (s.status === 'charging') {
        // ensure numeric fields exist
        s.kwhUsed = s.kwhUsed || 0;
        s.timeElapsedSeconds = s.timeElapsedSeconds || Math.floor((Date.now() - (s.startTime || Date.now())) / 1000);
        startChargingSimulation(id);
      }
    });

    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  } catch (e) {
    console.error('Server initialization failed:', e);
    process.exit(1);
  }
})();
