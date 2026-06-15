const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs   = require('fs');

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

// Configuración compartida — persiste en archivo para sobrevivir reinicios
const CONFIG_FILE = './controllucesapp_config.json';
let sharedConfig = null;

function loadConfigFromFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      sharedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log('[Config] Cargada desde archivo');
    }
  } catch(e) { console.error('[Config] Error cargando archivo:', e.message); }
}

function saveConfigToFile() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(sharedConfig), 'utf8');
  } catch(e) { console.error('[Config] Error guardando archivo:', e.message); }
}

loadConfigFromFile();

// ── TELEGRAM (polling centralizado en el servidor) ────────────────────────────
let tgOffset = 0;
let tgPollingInterval = null;

async function tgPost(method, body) {
  const token = sharedConfig?.telegram?.token;
  if (!token) return { ok: false };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  } catch(e) { return { ok: false }; }
}

async function tgSendMainMenu(chatId) {
  await tgPost('sendMessage', {
    chat_id: chatId,
    text: '💡 <b>ControlLuces WiFi</b>\nUsá los botones o escribí un comando:',
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: [
        ['📊 Estado', '💡 Canales'],
        ['🟢 Todos ON', '🔴 Todos OFF'],
        ['🎭 Escenas', '❓ Ayuda'],
      ],
      resize_keyboard: true,
      persistent: true,
    }
  });
}

async function tgSendChannelMenu(chatId, editMsgId = null) {
  const channels = sharedConfig?.channels || [];
  const buttons = [];
  for (let i = 0; i < 8; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, 8); j++) {
      const name = channels[j]?.name || `Canal ${j + 1}`;
      row.push({ text: `${relayState[j] ? '🟢' : '⚫'} ${name}`, callback_data: `ch_${j}` });
    }
    buttons.push(row);
  }
  buttons.push([
    { text: '🟢 Todos ON',  callback_data: 'all_on'  },
    { text: '🔴 Todos OFF', callback_data: 'all_off' },
  ]);
  const markup = { inline_keyboard: buttons };

  if (editMsgId) {
    await tgPost('editMessageReplyMarkup', { chat_id: chatId, message_id: editMsgId, reply_markup: markup });
  } else {
    await tgPost('sendMessage', {
      chat_id: chatId,
      text: '💡 <b>Canales</b>\nPulsá para encender o apagar:',
      parse_mode: 'HTML',
      reply_markup: markup,
    });
  }
}

async function tgSendScenesMenu(chatId) {
  const scenes = sharedConfig?.scenes || [];
  if (!scenes.length) {
    await tgPost('sendMessage', { chat_id: chatId, text: '🎭 No hay escenas guardadas. Creá una en la app.' });
    return;
  }
  const buttons = scenes.map(s => [{ text: `${s.icon || ''} ${s.name}`, callback_data: `scene_${s.id}` }]);
  await tgPost('sendMessage', {
    chat_id: chatId,
    text: '🎭 <b>Escenas</b>\nElegí una para activarla:',
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

function tgApplyScene(sceneId) {
  const scene = (sharedConfig?.scenes || []).find(s => s.id === sceneId);
  if (!scene) return null;
  if (scene.channels) {
    scene.channels.forEach((on, i) => { if (i < 8 && on !== undefined) relayState[i] = !!on; });
  }
  broadcast(buildStatus());
  return scene;
}

async function handleCallbackQuery(cb) {
  const chatId = String(sharedConfig?.telegram?.chatId || '');
  if (String(cb.from.id) !== chatId) return;
  const data = cb.data;
  const msgId = cb.message.message_id;
  const fromChatId = cb.message.chat.id;
  const channels = sharedConfig?.channels || [];

  if (/^ch_(\d+)$/.test(data)) {
    const id = parseInt(data.match(/^ch_(\d+)$/)[1]);
    relayState[id] = !relayState[id];
    broadcast(buildStatus());
    const name = channels[id]?.name || `Canal ${id + 1}`;
    await tgPost('answerCallbackQuery', { callback_query_id: cb.id, text: `${name}: ${relayState[id] ? '🟢 ON' : '⚫ OFF'}` });
    await tgSendChannelMenu(fromChatId, msgId);

  } else if (data === 'all_on') {
    relayState.fill(true);
    broadcast(buildStatus());
    await tgPost('answerCallbackQuery', { callback_query_id: cb.id, text: '🟢 Todos encendidos' });
    await tgSendChannelMenu(fromChatId, msgId);

  } else if (data === 'all_off') {
    relayState.fill(false);
    broadcast(buildStatus());
    await tgPost('answerCallbackQuery', { callback_query_id: cb.id, text: '🔴 Todos apagados' });
    await tgSendChannelMenu(fromChatId, msgId);

  } else if (/^scene_(\d+)$/.test(data)) {
    const sceneId = parseInt(data.match(/^scene_(\d+)$/)[1]);
    const scene = tgApplyScene(sceneId);
    await tgPost('answerCallbackQuery', { callback_query_id: cb.id, text: scene ? `✅ "${scene.name}" activada` : '❌ Escena no encontrada' });

  } else {
    await tgPost('answerCallbackQuery', { callback_query_id: cb.id });
  }
}

async function handleTelegramCommand(text, fromChatId) {
  text = text.split('@')[0].trim().toLowerCase();
  const channels = sharedConfig?.channels || [];

  if (text === '/start' || text === '/ayuda' || text === '/help' || text === '❓ ayuda') {
    await tgSendMainMenu(fromChatId);

  } else if (text === '/estado' || text === '/status' || text === '📊 estado') {
    const lines = relayState.map((on, i) => {
      const name = channels[i]?.name || `Canal ${i + 1}`;
      return `${on ? '🟢' : '⚫'} <b>${name}</b>: ${on ? 'ENCENDIDO' : 'APAGADO'}`;
    });
    await tgPost('sendMessage', {
      chat_id: fromChatId,
      text: `💡 <b>Estado de canales</b>\n\n${lines.join('\n')}`,
      parse_mode: 'HTML',
    });

  } else if (text === '💡 canales' || text === '/canales') {
    await tgSendChannelMenu(fromChatId);

  } else if (text === '🟢 todos on' || text === '/todos_on') {
    relayState.fill(true);
    broadcast(buildStatus());
    await tgPost('sendMessage', { chat_id: fromChatId, text: '✅ Todos los canales <b>ENCENDIDOS</b>', parse_mode: 'HTML' });

  } else if (text === '🔴 todos off' || text === '/todos_off') {
    relayState.fill(false);
    broadcast(buildStatus());
    await tgPost('sendMessage', { chat_id: fromChatId, text: '✅ Todos los canales <b>APAGADOS</b>', parse_mode: 'HTML' });

  } else if (text === '🎭 escenas' || text === '/escenas') {
    await tgSendScenesMenu(fromChatId);

  } else if (/^\/on([1-8])$/.test(text)) {
    const id = parseInt(text.match(/^\/on([1-8])$/)[1]) - 1;
    relayState[id] = true;
    broadcast(buildStatus());
    const name = channels[id]?.name || `Canal ${id + 1}`;
    await tgPost('sendMessage', { chat_id: fromChatId, text: `✅ <b>${name}</b> ENCENDIDO`, parse_mode: 'HTML' });

  } else if (/^\/off([1-8])$/.test(text)) {
    const id = parseInt(text.match(/^\/off([1-8])$/)[1]) - 1;
    relayState[id] = false;
    broadcast(buildStatus());
    const name = channels[id]?.name || `Canal ${id + 1}`;
    await tgPost('sendMessage', { chat_id: fromChatId, text: `✅ <b>${name}</b> APAGADO`, parse_mode: 'HTML' });

  } else if (text.startsWith('/escena ')) {
    const name = text.replace('/escena ', '').trim();
    const scene = (sharedConfig?.scenes || []).find(s => s.name.toLowerCase() === name);
    if (scene) {
      tgApplyScene(scene.id);
      await tgPost('sendMessage', { chat_id: fromChatId, text: `✅ Escena <b>${scene.name}</b> activada`, parse_mode: 'HTML' });
    } else {
      await tgPost('sendMessage', { chat_id: fromChatId, text: `❌ No encontré la escena "<b>${name}</b>"`, parse_mode: 'HTML' });
    }
  }
}

async function pollTelegram() {
  const tg = sharedConfig?.telegram;
  if (!tg?.token || !tg?.enabled) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/getUpdates?offset=${tgOffset}&timeout=1`);
    const data = await r.json();
    if (!data.ok) return;
    for (const update of data.result) {
      tgOffset = update.update_id + 1;
      if (update.callback_query) {
        await handleCallbackQuery(update.callback_query);
        continue;
      }
      const msg = update.message;
      if (!msg?.text) continue;
      if (String(msg.chat.id) !== String(tg.chatId)) continue;
      await handleTelegramCommand(msg.text.trim(), msg.chat.id);
    }
  } catch(e) { console.error('[Telegram] Poll error:', e.message); }
}

async function startTelegramPolling() {
  if (tgPollingInterval) { clearInterval(tgPollingInterval); tgPollingInterval = null; }
  const tg = sharedConfig?.telegram;
  if (!tg?.token || !tg?.enabled) return;
  // Avanzar el offset para no reprocesar mensajes previos al inicio del servidor
  try {
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/getUpdates?offset=-1&timeout=1`);
    const data = await r.json();
    if (data.ok && data.result.length > 0) {
      tgOffset = data.result[data.result.length - 1].update_id + 1;
      console.log(`[Telegram] Offset inicial: ${tgOffset}`);
    }
  } catch(e) {}
  tgPollingInterval = setInterval(pollTelegram, 2000);
  console.log('[Telegram] Polling iniciado');
}

// Arrancar polling si ya hay config al iniciar
if (sharedConfig?.telegram?.token && sharedConfig?.telegram?.enabled) {
  startTelegramPolling();
}

// ── WEBSOCKET ────────────────────────────────────────────────────────────────
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
            broadcastTo(ws, buildStatus());
            console.log(`[Relay] Canal ${msg.id + 1}: ${msg.on ? 'ON' : 'OFF'}`);
          }
          break;

        case 'setRelays':
          if (Array.isArray(msg.states)) {
            msg.states.forEach((v, i) => { if (i < 8) relayState[i] = !!v; });
            broadcastTo(ws, buildStatus());
          }
          break;

        case 'allOn':
          relayState.fill(true); broadcastTo(ws, buildStatus()); break;
        case 'allOff':
          relayState.fill(false); broadcastTo(ws, buildStatus()); break;

        case 'pulse':
          if (msg.id >= 0 && msg.id < 8) {
            relayState[msg.id] = true; broadcast(buildStatus());
            setTimeout(() => { relayState[msg.id] = false; broadcast(buildStatus()); }, msg.ms || 1000);
          }
          break;

        // ── Configuración compartida ──────────────────
        case 'setConfig':
          if (msg.config) {
            const prevTg = JSON.stringify(sharedConfig?.telegram);
            sharedConfig = msg.config;
            saveConfigToFile();
            broadcastTo(ws, { type: 'configUpdate', config: sharedConfig });
            console.log('[Config] Actualizada y guardada en disco');
            // Reiniciar polling si cambió la config de Telegram
            if (JSON.stringify(sharedConfig?.telegram) !== prevTg) {
              startTelegramPolling();
            }
          }
          break;

        case 'uploadConfig':
          if (!sharedConfig && msg.config) {
            sharedConfig = msg.config;
            saveConfigToFile();
            startTelegramPolling();
            console.log('[Config] Config inicial recibida y guardada');
          }
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
  version: '2.0',
  clients: wss.clients.size,
  relays: relayState,
  hasConfig: !!sharedConfig,
  telegramPolling: !!tgPollingInterval,
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
  if (req.body.config) {
    sharedConfig = req.body.config;
    broadcast({ type: 'configUpdate', config: sharedConfig });
    startTelegramPolling();
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🟢 ControlLuces Simulator en puerto ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`   REST API:  http://localhost:${PORT}/api/status\n`);
});
