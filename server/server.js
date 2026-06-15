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

// ── ESTADO ───────────────────────────────────────────────────────────────────
let relayState = Array(8).fill(false);

const CONFIG_FILE  = './controllucesapp_config.json';
const FIRED_FILE   = './lastfired.json';
let sharedConfig   = null;
let lastFiredRules = {};   // ruleId/sceneId → timestamp

function loadConfigFromFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      sharedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log('[Config] Cargada desde archivo');
    }
  } catch(e) { console.error('[Config] Error cargando:', e.message); }
}

function saveConfigToFile() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(sharedConfig), 'utf8'); } catch(e) {}
}

function loadLastFired() {
  try {
    if (!fs.existsSync(FIRED_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(FIRED_FILE, 'utf8'));
    const today  = new Date().toDateString();
    lastFiredRules = {};
    Object.entries(parsed).forEach(([k, v]) => {
      if (new Date(v).toDateString() === today) lastFiredRules[k] = v;
    });
  } catch(e) {}
}

function saveLastFired() {
  try { fs.writeFileSync(FIRED_FILE, JSON.stringify(lastFiredRules), 'utf8'); } catch(e) {}
}

loadConfigFromFile();
loadLastFired();

// ── WEBSOCKET HELPERS ────────────────────────────────────────────────────────
function broadcastTo(senderWs, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c !== senderWs && c.readyState === 1) c.send(msg); });
}
function broadcast(data) { broadcastTo(null, data); }
function buildInit()   { return { type: 'init',   relays: [...relayState], config: sharedConfig, hasConfig: !!sharedConfig }; }
function buildStatus() { return { type: 'status', relays: [...relayState] }; }

// ── TELEGRAM ─────────────────────────────────────────────────────────────────
let tgOffset          = 0;
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
      keyboard: [['📊 Estado', '💡 Canales'], ['🟢 Todos ON', '🔴 Todos OFF'], ['🎭 Escenas', '❓ Ayuda']],
      resize_keyboard: true, persistent: true,
    }
  });
}

async function tgSendChannelMenu(chatId, editMsgId = null) {
  const channels = sharedConfig?.channels || [];
  const buttons  = [];
  for (let i = 0; i < 8; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, 8); j++) {
      row.push({ text: `${relayState[j] ? '🟢' : '⚫'} ${channels[j]?.name || `Canal ${j+1}`}`, callback_data: `ch_${j}` });
    }
    buttons.push(row);
  }
  buttons.push([{ text: '🟢 Todos ON', callback_data: 'all_on' }, { text: '🔴 Todos OFF', callback_data: 'all_off' }]);
  const markup = { inline_keyboard: buttons };
  if (editMsgId) {
    await tgPost('editMessageReplyMarkup', { chat_id: chatId, message_id: editMsgId, reply_markup: markup });
  } else {
    await tgPost('sendMessage', { chat_id: chatId, text: '💡 <b>Canales</b>\nPulsá para encender o apagar:', parse_mode: 'HTML', reply_markup: markup });
  }
}

async function tgSendScenesMenu(chatId) {
  const scenes = sharedConfig?.scenes || [];
  if (!scenes.length) {
    await tgPost('sendMessage', { chat_id: chatId, text: '🎭 No hay escenas guardadas.' });
    return;
  }
  await tgPost('sendMessage', {
    chat_id: chatId,
    text: '🎭 <b>Escenas</b>\nElegí una para activarla:',
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: scenes.map(s => [{ text: `${s.icon||''} ${s.name}`, callback_data: `scene_${s.id}` }]) },
  });
}

function applyScene(sceneId) {
  const scene = (sharedConfig?.scenes || []).find(s => s.id === sceneId);
  if (!scene) return null;
  if (scene.channels) {
    relayState = relayState.map((_, i) => scene.channels.includes(i));
  }
  broadcast(buildStatus());
  return scene;
}

async function handleCallbackQuery(cb) {
  const chatId = String(sharedConfig?.telegram?.chatId || '');
  if (String(cb.from.id) !== chatId) return;
  const { data, message: { message_id: msgId, chat: { id: fromChatId } } } = cb;
  const channels = sharedConfig?.channels || [];

  if (/^ch_(\d+)$/.test(data)) {
    const id = parseInt(data.match(/^ch_(\d+)$/)[1]);
    relayState[id] = !relayState[id];
    broadcast(buildStatus());
    const name = channels[id]?.name || `Canal ${id+1}`;
    await tgPost('answerCallbackQuery', { callback_query_id: cb.id, text: `${name}: ${relayState[id] ? '🟢 ON' : '⚫ OFF'}` });
    await tgSendChannelMenu(fromChatId, msgId);
  } else if (data === 'all_on') {
    relayState.fill(true);  broadcast(buildStatus());
    await tgPost('answerCallbackQuery', { callback_query_id: cb.id, text: '🟢 Todos encendidos' });
    await tgSendChannelMenu(fromChatId, msgId);
  } else if (data === 'all_off') {
    relayState.fill(false); broadcast(buildStatus());
    await tgPost('answerCallbackQuery', { callback_query_id: cb.id, text: '🔴 Todos apagados' });
    await tgSendChannelMenu(fromChatId, msgId);
  } else if (/^scene_(\d+)$/.test(data)) {
    const scene = applyScene(parseInt(data.match(/^scene_(\d+)$/)[1]));
    await tgPost('answerCallbackQuery', { callback_query_id: cb.id, text: scene ? `✅ "${scene.name}" activada` : '❌ No encontrada' });
  } else {
    await tgPost('answerCallbackQuery', { callback_query_id: cb.id });
  }
}

async function handleTelegramCommand(text, fromChatId) {
  text = text.split('@')[0].trim().toLowerCase();
  const channels = sharedConfig?.channels || [];

  if (['\/start','\/ayuda','\/help','❓ ayuda'].includes(text)) {
    await tgSendMainMenu(fromChatId);
  } else if (['/estado','/status','📊 estado'].includes(text)) {
    const lines = relayState.map((on, i) => `${on ? '🟢' : '⚫'} <b>${channels[i]?.name || `Canal ${i+1}`}</b>: ${on ? 'ENCENDIDO' : 'APAGADO'}`);
    await tgPost('sendMessage', { chat_id: fromChatId, text: `💡 <b>Estado de canales</b>\n\n${lines.join('\n')}`, parse_mode: 'HTML' });
  } else if (['💡 canales','/canales'].includes(text)) {
    await tgSendChannelMenu(fromChatId);
  } else if (['🟢 todos on','/todos_on'].includes(text)) {
    relayState.fill(true);  broadcast(buildStatus());
    await tgPost('sendMessage', { chat_id: fromChatId, text: '✅ Todos los canales <b>ENCENDIDOS</b>', parse_mode: 'HTML' });
  } else if (['🔴 todos off','/todos_off'].includes(text)) {
    relayState.fill(false); broadcast(buildStatus());
    await tgPost('sendMessage', { chat_id: fromChatId, text: '✅ Todos los canales <b>APAGADOS</b>', parse_mode: 'HTML' });
  } else if (['🎭 escenas','/escenas'].includes(text)) {
    await tgSendScenesMenu(fromChatId);
  } else if (/^\/on([1-8])$/.test(text)) {
    const id = parseInt(text.match(/^\/on([1-8])$/)[1]) - 1;
    relayState[id] = true; broadcast(buildStatus());
    await tgPost('sendMessage', { chat_id: fromChatId, text: `✅ <b>${channels[id]?.name || `Canal ${id+1}`}</b> ENCENDIDO`, parse_mode: 'HTML' });
  } else if (/^\/off([1-8])$/.test(text)) {
    const id = parseInt(text.match(/^\/off([1-8])$/)[1]) - 1;
    relayState[id] = false; broadcast(buildStatus());
    await tgPost('sendMessage', { chat_id: fromChatId, text: `✅ <b>${channels[id]?.name || `Canal ${id+1}`}</b> APAGADO`, parse_mode: 'HTML' });
  } else if (text.startsWith('/escena ')) {
    const name  = text.replace('/escena ', '').trim();
    const scene = (sharedConfig?.scenes || []).find(s => s.name.toLowerCase() === name);
    if (scene) {
      applyScene(scene.id);
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
      if (update.callback_query) { await handleCallbackQuery(update.callback_query); continue; }
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
  try {
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/getUpdates?offset=-1&timeout=1`);
    const data = await r.json();
    if (data.ok && data.result.length > 0) {
      tgOffset = data.result[data.result.length - 1].update_id + 1;
    }
  } catch(e) {}
  tgPollingInterval = setInterval(pollTelegram, 2000);
  console.log('[Telegram] Polling iniciado');
}

// ── SCHEDULER ────────────────────────────────────────────────────────────────
let lastSunFetchKey = '';

function getMinutesFromIso(isoStr) {
  const d = new Date(isoStr);
  return d.getHours() * 60 + d.getMinutes();
}

function getRuleTargetMinutes(rule) {
  const sun = sharedConfig?.sun;
  const rise = sun?.sunrise ? getMinutesFromIso(sun.sunrise) : null;
  const set  = sun?.sunset  ? getMinutesFromIso(sun.sunset)  : null;
  switch(rule.trigger) {
    case 'sunset':         return set;
    case 'sunrise':        return rise;
    case 'sunset_before':  return set  != null ? set  - (rule.offset||0) : null;
    case 'sunset_after':   return set  != null ? set  + (rule.offset||0) : null;
    case 'sunrise_before': return rise != null ? rise - (rule.offset||0) : null;
    case 'sunrise_after':  return rise != null ? rise + (rule.offset||0) : null;
    case 'time': { if (!rule.time) return null; const [h,m] = rule.time.split(':').map(Number); return h*60+m; }
    default: return null;
  }
}

function getTriggerIcon(t) {
  return { sunset:'🌇', sunrise:'🌄', sunset_before:'🌅', sunset_after:'🌆', sunrise_before:'🌃', sunrise_after:'🌅', time:'⏰' }[t] || '⏰';
}

function getTriggerText(rule) {
  const sun = sharedConfig?.sun;
  const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('es-AR', {hour:'2-digit', minute:'2-digit'}) : '?';
  return {
    sunset:         `Al atardecer (${fmtTime(sun?.sunset)})`,
    sunrise:        `Al amanecer (${fmtTime(sun?.sunrise)})`,
    sunset_before:  `${rule.offset} min antes del atardecer`,
    sunset_after:   `${rule.offset} min después del atardecer`,
    sunrise_before: `${rule.offset} min antes del amanecer`,
    sunrise_after:  `${rule.offset} min después del amanecer`,
    time:           `A las ${rule.time}`,
  }[rule.trigger] || rule.trigger;
}

function getActionText(rule) {
  const channels = sharedConfig?.channels || [];
  if (rule.actionType === 'scene') {
    const s = (sharedConfig?.scenes || []).find(s => s.id === rule.sceneId);
    return s ? `Escena "${s.name}"` : 'Escena eliminada';
  }
  if (rule.actionType === 'all_on')  return '🟢 Encender todos';
  if (rule.actionType === 'all_off') return '🔴 Apagar todos';
  if (rule.actionType === 'channels') {
    const verb = rule.channelAction === 'off' ? '🔴 Apagar' : '🟢 Encender';
    return `${verb}: ${(rule.channels||[]).map(i => channels[i]?.name || `Canal ${i+1}`).join(', ')}`;
  }
  return '';
}

async function fireRule(rule) {
  const channels = sharedConfig?.channels || [];
  switch(rule.actionType) {
    case 'scene':
      applyScene(rule.sceneId);
      break;
    case 'all_on':
      relayState.fill(true);  broadcast(buildStatus()); break;
    case 'all_off':
      relayState.fill(false); broadcast(buildStatus()); break;
    case 'channels': {
      const on = rule.channelAction !== 'off';
      (rule.channels || []).forEach(i => { if (i < 8) relayState[i] = on; });
      broadcast(buildStatus()); break;
    }
  }
  const tg = sharedConfig?.telegram;
  if (tg?.token && tg?.chatId && tg?.enabled) {
    await tgPost('sendMessage', {
      chat_id: tg.chatId,
      text: `${getTriggerIcon(rule.trigger)} <b>Automatización:</b> ${rule.name}\n${getTriggerText(rule)} → ${getActionText(rule)}`,
      parse_mode: 'HTML',
    });
  }
  console.log(`[Scheduler] Regla: "${rule.name}" → ${getActionText(rule)}`);
}

async function fetchSunData() {
  const loc = sharedConfig?.location;
  if (!loc?.lat || !loc?.lng) return;
  try {
    const r = await fetch(`https://api.sunrise-sunset.org/json?lat=${loc.lat}&lng=${loc.lng}&formatted=0`);
    const data = await r.json();
    if (data.status === 'OK' && sharedConfig) {
      sharedConfig.sun = { sunrise: data.results.sunrise, sunset: data.results.sunset, date: new Date().toDateString() };
      saveConfigToFile();
      broadcast({ type: 'configUpdate', config: sharedConfig });
      const rise = new Date(sharedConfig.sun.sunrise).toLocaleTimeString('es-AR', {hour:'2-digit',minute:'2-digit'});
      const set  = new Date(sharedConfig.sun.sunset ).toLocaleTimeString('es-AR', {hour:'2-digit',minute:'2-digit'});
      console.log(`[Sun] Amanecer: ${rise} | Atardecer: ${set}`);
    }
  } catch(e) { console.error('[Sun] Error:', e.message); }
}

async function checkSchedules() {
  if (!sharedConfig) return;
  const now        = new Date();
  const todayStr   = now.toDateString();
  const todayDay   = now.getDay();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const h = now.getHours(), m = now.getMinutes();

  // Auto-refresh datos del sol
  const slotKey = `${todayStr}-${h}`;
  const stale   = sharedConfig.sun?.date !== todayStr;
  if ((stale || (h === 1 && m <= 1) || (h === 13 && m <= 1)) && lastSunFetchKey !== slotKey) {
    lastSunFetchKey = slotKey;
    await fetchSunData();
  }

  // Reglas
  for (const rule of (sharedConfig.rules || [])) {
    if (!rule.enabled) continue;
    if (!(rule.days || [0,1,2,3,4,5,6]).includes(todayDay)) continue;
    const targetMinutes = getRuleTargetMinutes(rule);
    if (targetMinutes === null) continue;
    const lastFire = lastFiredRules[rule.id];
    const alreadyFiredToday = lastFire && new Date(lastFire).toDateString() === todayStr;
    if (!alreadyFiredToday && Math.abs(nowMinutes - targetMinutes) <= 1) {
      lastFiredRules[rule.id] = Date.now();
      saveLastFired();
      await fireRule(rule);
    }
  }

  // Escenas programadas
  for (const scene of (sharedConfig.scenes || [])) {
    if (!scene.time || !scene.days?.length) continue;
    if (!scene.days.includes(todayDay)) continue;
    const [sh, sm] = scene.time.split(':').map(Number);
    const targetMinutes = sh * 60 + sm;
    const key = `scene_${scene.id}`;
    const lastFire = lastFiredRules[key];
    const alreadyFiredToday = lastFire && new Date(lastFire).toDateString() === todayStr;
    if (!alreadyFiredToday && Math.abs(nowMinutes - targetMinutes) <= 1) {
      lastFiredRules[key] = Date.now();
      saveLastFired();
      applyScene(scene.id);
      const tg = sharedConfig?.telegram;
      if (tg?.token && tg?.chatId && tg?.enabled) {
        await tgPost('sendMessage', {
          chat_id: tg.chatId,
          text: `⏰ <b>Escena programada:</b> ${scene.icon||''} ${scene.name}`,
          parse_mode: 'HTML',
        });
      }
      console.log(`[Scheduler] Escena: "${scene.name}"`);
    }
  }
}

// Iniciar Telegram y scheduler
if (sharedConfig?.telegram?.token && sharedConfig?.telegram?.enabled) {
  startTelegramPolling();
}
setInterval(checkSchedules, 30000);
setTimeout(checkSchedules, 5000);   // primera verificación 5s después de arrancar

// ── WEBSOCKET ────────────────────────────────────────────────────────────────
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
          ws.send(JSON.stringify({ type: 'pong' })); break;

        case 'getStatus':
          ws.send(JSON.stringify(buildInit())); break;

        case 'setRelay':
          if (msg.id >= 0 && msg.id < 8) {
            relayState[msg.id] = !!msg.on;
            broadcastTo(ws, buildStatus());
            console.log(`[Relay] Canal ${msg.id+1}: ${msg.on ? 'ON' : 'OFF'}`);
          }
          break;

        case 'setRelays':
          if (Array.isArray(msg.states)) {
            msg.states.forEach((v, i) => { if (i < 8) relayState[i] = !!v; });
            broadcastTo(ws, buildStatus());
          }
          break;

        case 'allOn':  relayState.fill(true);  broadcastTo(ws, buildStatus()); break;
        case 'allOff': relayState.fill(false); broadcastTo(ws, buildStatus()); break;

        case 'pulse':
          if (msg.id >= 0 && msg.id < 8) {
            relayState[msg.id] = true; broadcast(buildStatus());
            setTimeout(() => { relayState[msg.id] = false; broadcast(buildStatus()); }, msg.ms || 1000);
          }
          break;

        case 'setConfig':
          if (msg.config) {
            const prevTg = JSON.stringify(sharedConfig?.telegram);
            sharedConfig = msg.config;
            saveConfigToFile();
            broadcastTo(ws, { type: 'configUpdate', config: sharedConfig });
            console.log('[Config] Actualizada y guardada');
            if (JSON.stringify(sharedConfig?.telegram) !== prevTg) startTelegramPolling();
          }
          break;

        case 'uploadConfig':
          if (!sharedConfig && msg.config) {
            sharedConfig = msg.config;
            saveConfigToFile();
            startTelegramPolling();
            console.log('[Config] Config inicial guardada');
          }
          ws.send(JSON.stringify({ type: 'configUpdate', config: sharedConfig }));
          break;
      }
    } catch(e) { console.error('[WS] Error:', e.message); }
  });

  ws.on('close', () => console.log(`[WS] Desconectado: ${ip} (clientes: ${wss.clients.size})`));
});

// ── REST API ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  service: 'ControlLuces Simulator',
  version: '2.1',
  clients: wss.clients.size,
  relays: relayState,
  hasConfig: !!sharedConfig,
  telegramPolling: !!tgPollingInterval,
  sun: sharedConfig?.sun || null,
}));

app.get('/api/status', (req, res) => res.json({ ok: true, relays: relayState, simulation: true }));
app.get('/api/config', (req, res) => res.json({ ok: true, config: sharedConfig }));

app.post('/api/relay',  (req, res) => { const { id, on } = req.body; if (id >= 0 && id < 8) { relayState[id] = !!on; broadcast(buildStatus()); } res.json({ ok: true }); });
app.post('/api/relays', (req, res) => { const { states } = req.body; if (Array.isArray(states)) states.forEach((v,i) => { if (i<8) relayState[i]=!!v; }); broadcast(buildStatus()); res.json({ ok: true }); });
app.post('/api/allOn',  (req, res) => { relayState.fill(true);  broadcast(buildStatus()); res.json({ ok: true }); });
app.post('/api/allOff', (req, res) => { relayState.fill(false); broadcast(buildStatus()); res.json({ ok: true }); });
app.post('/api/config', (req, res) => { if (req.body.config) { sharedConfig = req.body.config; broadcast({ type: 'configUpdate', config: sharedConfig }); startTelegramPolling(); } res.json({ ok: true }); });

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🟢 ControlLuces en puerto ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`   REST API:  http://localhost:${PORT}/api/status\n`);
});
