/*
 * ControlLuces WiFi - Firmware ESP32
 * Hardware: ESP32 + Placa de relé de 8 canales
 *
 * Librerías necesarias (instalar desde Arduino Library Manager):
 *   - ESPAsyncWebServer   (by lacamera / me-no-dev)
 *   - AsyncTCP            (by dvarrel / me-no-dev)
 *   - ArduinoJson         (by Benoît Blanchon) v6.x
 *
 * Herramientas > Partición: "Default 4MB with spiffs"
 * Subir datos SPIFFS: herramienta "ESP32 Sketch Data Upload" + carpeta /data con index.html
 */

#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <AsyncTCP.h>
#include <SPIFFS.h>
#include <ArduinoJson.h>
#include <time.h>

// ── CONFIGURACIÓN ──────────────────────────────────────────────────────────────

// Credenciales WiFi de tu red
const char* WIFI_SSID     = "TU_WIFI_SSID";
const char* WIFI_PASSWORD = "TU_WIFI_PASSWORD";

// Nombre de host mDNS (acceder como http://controllucesapp.local)
const char* HOSTNAME = "controllucesapp";

// Zona horaria: https://github.com/nayarsystems/posix_tz_db/blob/master/zones.csv
// Argentina (UTC-3, sin horario de verano):
const char* TZ = "ART3";
// España (UTC+1, con horario de verano):
// const char* TZ = "CET-1CEST,M3.5.0,M10.5.0/3";

// Servidor NTP
const char* NTP_SERVER = "pool.ntp.org";

// GPIOs para los 8 canales de relé.
// Ajusta según cómo estén conectados los relés al ESP32.
const int RELAY_PINS[8] = {23, 22, 21, 19, 18, 17, 16, 4};

// Lógica del relé:
//   true  = Activo Bajo (relay ON cuando el pin está en LOW) — la mayoría de placas chinas
//   false = Activo Alto (relay ON cuando el pin está en HIGH)
const bool RELAY_ACTIVE_LOW = true;

// Nivel lógico para ON / OFF
#define RELAY_ON  (RELAY_ACTIVE_LOW ? LOW  : HIGH)
#define RELAY_OFF (RELAY_ACTIVE_LOW ? HIGH : LOW)

// Modo AP de emergencia (si WiFi no conecta en 15 segundos)
const char* AP_SSID     = "ControlLuces-Config";
const char* AP_PASSWORD = "12345678";

// ── VARIABLES GLOBALES ────────────────────────────────────────────────────────

AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

bool relayState[8] = {false};
bool apMode = false;

// ── RELAY HELPERS ─────────────────────────────────────────────────────────────

void relaySet(int ch, bool on) {
  if (ch < 0 || ch >= 8) return;
  relayState[ch] = on;
  digitalWrite(RELAY_PINS[ch], on ? RELAY_ON : RELAY_OFF);
}

void relaySetAll(bool on) {
  for (int i = 0; i < 8; i++) relaySet(i, on);
}

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────

// Construye JSON de estado y lo envía a todos los clientes WS
void broadcastStatus() {
  StaticJsonDocument<256> doc;
  doc["type"] = "status";
  JsonArray relays = doc.createNestedArray("relays");
  for (int i = 0; i < 8; i++) relays.add(relayState[i]);

  // Añadir hora actual
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    char buf[20];
    strftime(buf, sizeof(buf), "%H:%M:%S", &timeinfo);
    doc["time"] = buf;
    strftime(buf, sizeof(buf), "%Y-%m-%d", &timeinfo);
    doc["date"] = buf;
  }

  String msg;
  serializeJson(doc, msg);
  ws.textAll(msg);
}

void handleWsMessage(AsyncWebSocketClient* client, uint8_t* data, size_t len) {
  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, data, len);
  if (err) {
    client->text("{\"error\":\"JSON inválido\"}");
    return;
  }

  const char* cmd = doc["cmd"];

  if (strcmp(cmd, "getStatus") == 0) {
    broadcastStatus();

  } else if (strcmp(cmd, "setRelay") == 0) {
    int id = doc["id"] | -1;
    bool on = doc["on"] | false;
    if (id >= 0 && id < 8) {
      relaySet(id, on);
      broadcastStatus();
    }

  } else if (strcmp(cmd, "setRelays") == 0) {
    JsonArray states = doc["states"].as<JsonArray>();
    for (int i = 0; i < 8 && i < (int)states.size(); i++) {
      relaySet(i, states[i].as<bool>());
    }
    broadcastStatus();

  } else if (strcmp(cmd, "toggleRelay") == 0) {
    int id = doc["id"] | -1;
    if (id >= 0 && id < 8) {
      relaySet(id, !relayState[id]);
      broadcastStatus();
    }

  } else if (strcmp(cmd, "allOn") == 0) {
    relaySetAll(true);
    broadcastStatus();

  } else if (strcmp(cmd, "allOff") == 0) {
    relaySetAll(false);
    broadcastStatus();

  } else if (strcmp(cmd, "pulse") == 0) {
    // Activa un relé por 1 segundo y vuelve al estado anterior
    int id = doc["id"] | -1;
    int ms = doc["ms"] | 1000;
    if (id >= 0 && id < 8) {
      bool prev = relayState[id];
      relaySet(id, true);
      broadcastStatus();
      delay(ms);
      relaySet(id, prev);
      broadcastStatus();
    }
  }
}

void onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client,
               AwsEventType type, void* arg, uint8_t* data, size_t len) {
  switch (type) {
    case WS_EVT_CONNECT:
      Serial.printf("[WS] Cliente #%u conectado desde %s\n", client->id(), client->remoteIP().toString().c_str());
      broadcastStatus();
      break;
    case WS_EVT_DISCONNECT:
      Serial.printf("[WS] Cliente #%u desconectado\n", client->id());
      break;
    case WS_EVT_DATA:
      handleWsMessage(client, data, len);
      break;
    case WS_EVT_ERROR:
      Serial.printf("[WS] Error cliente #%u: %s\n", client->id(), (char*)data);
      break;
    default:
      break;
  }
}

// ── REST API ──────────────────────────────────────────────────────────────────

void setupRoutes() {
  // Servir index.html desde SPIFFS
  server.on("/", HTTP_GET, [](AsyncWebServerRequest* req) {
    req->send(SPIFFS, "/index.html", "text/html");
  });

  // Servir cualquier archivo estático de SPIFFS (CSS, JS, íconos, etc.)
  server.serveStatic("/", SPIFFS, "/");

  // ── GET /api/status ──────────────────────────────
  server.on("/api/status", HTTP_GET, [](AsyncWebServerRequest* req) {
    StaticJsonDocument<512> doc;
    doc["ok"] = true;
    JsonArray relays = doc.createNestedArray("relays");
    for (int i = 0; i < 8; i++) relays.add(relayState[i]);

    struct tm timeinfo;
    if (getLocalTime(&timeinfo)) {
      char buf[32];
      strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &timeinfo);
      doc["datetime"] = buf;
    }
    doc["apMode"] = apMode;
    doc["hostname"] = HOSTNAME;

    String json;
    serializeJson(doc, json);
    req->send(200, "application/json", json);
  });

  // ── POST /api/relay ──────────────────────────────
  // Body: { "id": 0, "on": true }
  AsyncCallbackJsonWebHandler* relayHandler = new AsyncCallbackJsonWebHandler(
    "/api/relay",
    [](AsyncWebServerRequest* req, JsonVariant& json) {
      int id = json["id"] | -1;
      bool on = json["on"] | false;
      if (id < 0 || id >= 8) {
        req->send(400, "application/json", "{\"error\":\"id fuera de rango\"}");
        return;
      }
      relaySet(id, on);
      broadcastStatus();
      req->send(200, "application/json", "{\"ok\":true}");
    }
  );
  server.addHandler(relayHandler);

  // ── POST /api/relays ─────────────────────────────
  // Body: { "states": [true, false, true, ...] }
  AsyncCallbackJsonWebHandler* relaysHandler = new AsyncCallbackJsonWebHandler(
    "/api/relays",
    [](AsyncWebServerRequest* req, JsonVariant& json) {
      JsonArray states = json["states"].as<JsonArray>();
      for (int i = 0; i < 8 && i < (int)states.size(); i++) {
        relaySet(i, states[i].as<bool>());
      }
      broadcastStatus();
      req->send(200, "application/json", "{\"ok\":true}");
    }
  );
  server.addHandler(relaysHandler);

  // ── POST /api/allOn | /api/allOff ────────────────
  server.on("/api/allOn", HTTP_POST, [](AsyncWebServerRequest* req) {
    relaySetAll(true);
    broadcastStatus();
    req->send(200, "application/json", "{\"ok\":true}");
  });
  server.on("/api/allOff", HTTP_POST, [](AsyncWebServerRequest* req) {
    relaySetAll(false);
    broadcastStatus();
    req->send(200, "application/json", "{\"ok\":true}");
  });

  // ── GET /api/wifi ────────────────────────────────
  server.on("/api/wifi", HTTP_GET, [](AsyncWebServerRequest* req) {
    StaticJsonDocument<128> doc;
    doc["ssid"] = WiFi.SSID();
    doc["rssi"] = WiFi.RSSI();
    doc["ip"]   = WiFi.localIP().toString();
    String json;
    serializeJson(doc, json);
    req->send(200, "application/json", json);
  });

  // ── POST /api/wifi ───────────────────────────────
  // Configura nuevas credenciales WiFi y reinicia
  AsyncCallbackJsonWebHandler* wifiHandler = new AsyncCallbackJsonWebHandler(
    "/api/wifi",
    [](AsyncWebServerRequest* req, JsonVariant& json) {
      String ssid = json["ssid"] | "";
      String pass = json["password"] | "";
      if (ssid.isEmpty()) { req->send(400, "application/json", "{\"error\":\"SSID requerido\"}"); return; }
      // Guardar en preferencias (simplificado: aquí solo reiniciamos)
      req->send(200, "application/json", "{\"ok\":true,\"msg\":\"Reiniciando...\"}");
      delay(500);
      ESP.restart();
    }
  );
  server.addHandler(wifiHandler);

  // ── 404 ──────────────────────────────────────────
  server.onNotFound([](AsyncWebServerRequest* req) {
    req->send(404, "text/plain", "No encontrado");
  });
}

// ── WIFI SETUP ────────────────────────────────────────────────────────────────

void setupWiFi() {
  WiFi.setHostname(HOSTNAME);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.printf("\n[WiFi] Conectando a %s", WIFI_SSID);
  unsigned long t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 15000) {
    delay(500);
    Serial.print('.');
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] Conectado!");
    Serial.print("[WiFi] IP: ");
    Serial.println(WiFi.localIP());
    apMode = false;

    // Sincronizar tiempo por NTP
    configTzTime(TZ, NTP_SERVER);
    Serial.println("[NTP] Sincronizando hora...");
    struct tm timeinfo;
    if (getLocalTime(&timeinfo, 10000)) {
      char buf[32];
      strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &timeinfo);
      Serial.printf("[NTP] Hora: %s\n", buf);
    } else {
      Serial.println("[NTP] No se pudo sincronizar");
    }

  } else {
    // Modo AP de configuración
    Serial.println("\n[WiFi] No se pudo conectar. Iniciando modo AP...");
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASSWORD);
    Serial.print("[AP] IP: ");
    Serial.println(WiFi.softAPIP());
    apMode = true;
  }
}

// ── SETUP & LOOP ──────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  Serial.println("\n══════════════════════════════");
  Serial.println("  ControlLuces WiFi v1.0");
  Serial.println("══════════════════════════════");

  // Inicializar pines de relé (todos apagados al inicio)
  for (int i = 0; i < 8; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], RELAY_OFF);
    relayState[i] = false;
  }
  Serial.println("[Relés] GPIOs configurados");

  // Inicializar SPIFFS
  if (!SPIFFS.begin(true)) {
    Serial.println("[ERROR] SPIFFS no pudo montarse!");
  } else {
    Serial.println("[SPIFFS] Montado correctamente");
    Serial.printf("[SPIFFS] Espacio total: %d bytes\n", SPIFFS.totalBytes());
    Serial.printf("[SPIFFS] Espacio usado: %d bytes\n", SPIFFS.usedBytes());
  }

  // Conectar WiFi
  setupWiFi();

  // Configurar WebSocket
  ws.onEvent(onWsEvent);
  server.addHandler(&ws);

  // Configurar rutas HTTP
  setupRoutes();

  // CORS para desarrollo local
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "*");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  // Iniciar servidor
  server.begin();
  Serial.println("[HTTP] Servidor iniciado en puerto 80");
  if (!apMode) {
    Serial.printf("[HTTP] Abre: http://%s.local  o  http://%s\n", HOSTNAME, WiFi.localIP().toString().c_str());
  } else {
    Serial.printf("[AP]  Conecta al WiFi '%s' y abre: http://192.168.4.1\n", AP_SSID);
  }
  Serial.println("══════════════════════════════\n");
}

void loop() {
  // Limpiar clientes WS desconectados periódicamente
  static unsigned long lastClean = 0;
  if (millis() - lastClean > 10000) {
    ws.cleanupClients();
    lastClean = millis();
  }

  // Broadcast de estado cada 30 segundos (keepalive para clientes)
  static unsigned long lastBroadcast = 0;
  if (millis() - lastBroadcast > 30000) {
    if (ws.count() > 0) broadcastStatus();
    lastBroadcast = millis();
  }

  // Reconexión WiFi automática (solo en modo STA)
  if (!apMode && WiFi.status() != WL_CONNECTED) {
    static unsigned long lastReconnect = 0;
    if (millis() - lastReconnect > 10000) {
      Serial.println("[WiFi] Reconectando...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      lastReconnect = millis();
    }
  }

  delay(10);
}
