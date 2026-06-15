const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Estado de relés
let relayState = Array(8).fill(false);

// Configuración compartida (persiste mientras el servidor corra)
// Incluye: canales, escenas, reglas, ubicación, sol, telegram, tema
let sharedConfig = null;

function broadcastTo(senderWs, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== senderWs && client.readyState === 1) client.send(msg);
  });
}

function broadcast(data) {
  broadcastTo(null, data);
}

function buildInit() {
  return {
    type: 'init',
    relays: [...relayState],
    config: sharedConfig,
    hasConfig: !!sharedConfig,
  };
}

function buildStatus() {
  return { type: 'status', relays: [...relayState] };
}

// Heartbeat: ping cada 25s para mantener vivas las conexiones en Render
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => clearInterval(heartbeatInterval));

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const ip = req.socket.remoteAddress;
  console.log(`[WS] Conectado: ${ip} (clientes: ${wss.clients.size})`);

  // Al conectar, enviar estado actual + configuración
  ws.send(JSON.stringify(buildInit()));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.cmd) {

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        case 'getStatus':
          ws.send(JSON.stringify(buildInit()));
          break;

        // ── Control de relés ──────────────────────────
        case 'setRelay':
          if (msg.id >= 0 && msg.id < 8) {
            relayState[msg.id] = !!msg.on;
            broadcast(buildStatus());
            console.log(`[Relay] Canal ${msg.id + 1}: ${msg.on ? 'ON' : 'OFF'}`);
          }
          break;

        case 'setRelays':
          if (Array.isArray(msg.states)) {
            msg.states.forEach((v, i) => { if (i < 8) relayState[i] = !!v; });
            broadcast(buildStatus());
          }
          break;

        case 'allOn':
          relayState.fill(true); broadcast(buildStatus()); break;
        case 'allOff':
          relayState.fill(false); broadcast(buildStatus()); break;

        case 'pulse':
          if (msg.id >= 0 && msg.id < 8) {
            relayState[msg.id] = true; broadcast(buildStatus());
            setTimeout(() => { relayState[msg.id] = false; broadcast(buildStatus()); }, msg.ms || 1000);
          }
          break;

        // ── Configuración compartida ──────────────────
        case 'setConfig':
          // Un dispositivo actualizó la config — guardar y notificar a los demás
          if (msg.config) {
            sharedConfig = msg.config;
            broadcastTo(ws, { type: 'configUpdate', config: sharedConfig });
            console.log('[Config] Actualizada y sincronizada');
          }
          break;

        case 'uploadConfig':
          // Primer dispositivo que conecta sube su config local si el server no tiene
          if (!sharedConfig && msg.config) {
            sharedConfig = msg.config;
            console.log('[Config] Config inicial recibida del primer cliente');
          }
          // Responder con la config que quedó (la del servidor o la recién subida)
          ws.send(JSON.stringify({ type: 'configUpdate', config: sharedConfig }));
          break;
      }
    } catch (e) { console.error('[WS] Error parsing message:', e.message); }
  });

  ws.on('close', () => console.log(`[WS] Desconectado: ${ip} (clientes: ${wss.clients.size})`));
});

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  service: 'ControlLuces Simulator',
  version: '1.0',
  clients: wss.clients.size,
  relays: relayState,
  hasConfig: !!sharedConfig,
}));

app.get('/api/status', (req, res) => res.json({ ok: true, relays: relayState, simulation: true }));
app.get('/api/config', (req, res) => res.json({ ok: true, config: sharedConfig }));

app.post('/api/relay', (req, res) => {
  const { id, on } = req.body;
  if (id >= 0 && id < 8) { relayState[id] = !!on; broadcast(buildStatus()); }
  res.json({ ok: true });
});

app.post('/api/relays', (req, res) => {
  const { states } = req.body;
  if (Array.isArray(states)) states.forEach((v, i) => { if (i < 8) relayState[i] = !!v; });
  broadcast(buildStatus());
  res.json({ ok: true });
});

app.post('/api/allOn',  (req, res) => { relayState.fill(true);  broadcast(buildStatus()); res.json({ ok: true }); });
app.post('/api/allOff', (req, res) => { relayState.fill(false); broadcast(buildStatus()); res.json({ ok: true }); });

app.post('/api/config', (req, res) => {
  if (req.body.config) { sharedConfig = req.body.config; broadcast({ type: 'configUpdate', config: sharedConfig }); }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🟢 ControlLuces Simulator en puerto ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`   REST API:  http://localhost:${PORT}/api/status\n`);
});
