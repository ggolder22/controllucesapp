const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Estado simulado de 8 relés (persiste mientras el servidor esté corriendo)
let relayState = Array(8).fill(false);

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

function buildStatus() {
  return {
    type: 'status',
    relays: [...relayState],
    simulation: true,
    time: new Date().toLocaleTimeString('es-AR'),
  };
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] Cliente conectado: ${ip}`);
  ws.send(JSON.stringify(buildStatus()));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      switch (msg.cmd) {
        case 'getStatus':
          broadcast(buildStatus());
          break;
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
          relayState.fill(true);
          broadcast(buildStatus());
          break;
        case 'allOff':
          relayState.fill(false);
          broadcast(buildStatus());
          break;
        case 'pulse':
          if (msg.id >= 0 && msg.id < 8) {
            relayState[msg.id] = true;
            broadcast(buildStatus());
            setTimeout(() => { relayState[msg.id] = false; broadcast(buildStatus()); }, msg.ms || 1000);
          }
          break;
      }
    } catch (e) {}
  });

  ws.on('close', () => console.log(`[WS] Cliente desconectado: ${ip}`));
});

// ── REST API (mismo contrato que el ESP32) ────────────────────────────────────
app.get('/', (req, res) => res.json({ service: 'ControlLuces Simulator', version: '1.0', relays: relayState }));

app.get('/api/status', (req, res) => res.json({ ok: true, relays: relayState, simulation: true }));

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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🟢 ControlLuces Simulator corriendo en puerto ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`   REST API:  http://localhost:${PORT}/api/status\n`);
});
