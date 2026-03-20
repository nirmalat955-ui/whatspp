// index.js - WhatsApp Bot V9 with Group Extractor
import express from "express";
import path from "path";
import fs from "fs";
import P from "pino";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 21833;

app.use(express.json({ limit: "5mb" }));

let sock;
let isSending = false;
let sendInterval;
let logs = [];
let clients = [];
const serverStartTime = Date.now();

/* ------------------------------
   🧹 Auto Clean Auth Folder
------------------------------ */
function autoCleanAuthFolder() {
  const authFolder = path.join(process.cwd(), "auth_info");
  if (!fs.existsSync(authFolder)) return;

  fs.readdirSync(authFolder).forEach((file) => {
    const filePath = path.join(authFolder, file);

    if (["creds.json", "noise-key.json"].includes(file)) return;

    if (file.startsWith("pre-key-")) {
      const num = parseInt(file.split("-")[2]);
      if (!isNaN(num) && num > 100) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Deleted old PreKey file: ${file}`);
      }
      return;
    }

    if (file.startsWith("sender-key-")) {
      const ageHours = (Date.now() - fs.statSync(filePath).mtimeMs) / 3600000;
      if (ageHours > 24) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Deleted old SenderKey: ${file}`);
      }
      return;
    }

    if (file.startsWith("session-")) {
      const ageHours = (Date.now() - fs.statSync(filePath).mtimeMs) / 3600000;
      if (ageHours > 48) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Deleted old Session file: ${file}`);
      }
    }
  });
}

/* ------------------------------
   🪵 Log Broadcasting (SSE)
------------------------------ */
function broadcastLog(message) {
  const now = Date.now();
  const entry = { time: new Date(now).toISOString(), message };

  logs = logs.filter((l) => new Date(l.time).getTime() > now - 20 * 60 * 1000);
  logs.push(entry);
  if (logs.length > 500) logs.shift();

  clients.forEach((c) => c.write(`data: ${JSON.stringify(entry)}\n\n`));
  console.log(entry.message);
}

/* ------------------------------
   🔗 WhatsApp Connection
------------------------------ */
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const reason =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.statusCode;

      if (reason !== DisconnectReason.loggedOut) {
        broadcastLog("⚠️ Connection closed, reconnecting...");
        setTimeout(connectWhatsApp, 3000);
      } else {
        broadcastLog("❌ Logged out. Delete auth_info to reconnect.");
      }
    } else if (connection === "open") {
      broadcastLog("✅ WhatsApp Connected Successfully!");
      autoCleanAuthFolder();
    }
  });
}
/* ------------------------------
   📡 SSE - Real-time Logs
------------------------------ */
app.get("/logs", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  logs.forEach((l) => res.write(`data: ${JSON.stringify(l)}\n\n`));
  clients.push(res);

  req.on("close", () => {
    clients = clients.filter((c) => c !== res);
  });
});

/* ------------------------------
   🔑 Pairing Code API
------------------------------ */
app.post("/pair", async (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).send({ error: "Number required" });

  try {
    const code = await sock.requestPairingCode(number);
    broadcastLog(`🔗 Pair code generated for ${number}: ${code}`);
    res.send({ code });
  } catch (err) {
    broadcastLog(`❌ Pairing failed: ${err.message}`);
    res.status(500).send({ error: err.message });
  }
});

/* ------------------------------
   🔍 Extract Groups API (NEW)
------------------------------ */
app.get("/extract-groups", async (req, res) => {
  if (!sock?.user) {
    return res.status(500).send({ error: "WhatsApp not connected" });
  }

  try {
    broadcastLog("🔍 Extracting groups...");
    
    const groups = await sock.groupFetchAllParticipating();
    const groupList = Object.values(groups).map(group => ({
      id: group.id,
      name: group.subject || "Unnamed Group",
      participants: group.participants ? group.participants.length : 0,
      owner: group.owner || "Unknown",
      created: group.creation ? new Date(group.creation * 1000).toLocaleDateString() : "Unknown"
    }));

    broadcastLog(`✅ Found ${groupList.length} groups`);
    res.send({ success: true, groups: groupList, count: groupList.length });
  } catch (err) {
    broadcastLog(`❌ Group extraction failed: ${err.message}`);
    res.status(500).send({ error: err.message });
  }
});

/* ------------------------------
   📤 Start Sending Messages
------------------------------ */
app.post("/start", async (req, res) => {
  const { targets, delay, haterName } = req.body;
  if (!sock?.user)
    return res.status(500).send({ error: "WhatsApp not connected" });

  const filePath = path.join(process.cwd(), "messages.txt");
  if (!fs.existsSync(filePath))
    return res.status(400).send({ error: "messages.txt not found" });

  const numbers = targets.split(",").map((n) => n.trim());
  const messages = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!messages.length)
    return res.status(400).send({ error: "messages.txt is empty" });

  isSending = true;
  let msgIndex = 0,
    numIndex = 0;

  broadcastLog(`🚀 Sending started to ${numbers.join(", ")}`);

  sendInterval = setInterval(async () => {
    if (!isSending || !sock?.user) {
      clearInterval(sendInterval);
      broadcastLog("⚠️ Sending stopped - disconnected.");
      return;
    }

    try {
      const text = haterName
        ? `[${haterName}] ${messages[msgIndex]}`
        : messages[msgIndex];
      const jid = numbers[numIndex].endsWith("@g.us")
        ? numbers[numIndex]
        : numbers[numIndex] + "@s.whatsapp.net";

      await sock.sendMessage(jid, { text });
      broadcastLog(`✅ Sent to ${numbers[numIndex]}: ${text}`);
    } catch (e) {
      broadcastLog(`❌ Error sending to ${numbers[numIndex]}: ${e.message}`);
    }

    msgIndex = (msgIndex + 1) % messages.length;
    numIndex = (numIndex + 1) % numbers.length;
  }, Math.max(delay || 2000, 1500));

  res.send({ status: "started", targets: numbers, delay });
});

/* ------------------------------
   🛑 Stop Sending
------------------------------ */
app.post("/stop", (req, res) => {
  isSending = false;
  clearInterval(sendInterval);
  sendInterval = null;
  broadcastLog("⏹️ Message sending stopped.");
  res.send({ status: "stopped" });
});

/* ------------------------------
   💚 Health Check (Uptime)
------------------------------ */
app.get("/health", (req, res) => {
  const uptime = Date.now() - serverStartTime;
  const days = Math.floor(uptime / 86400000);
  const hours = Math.floor((uptime / 3600000) % 24);
  const mins = Math.floor((uptime / 60000) % 60);
  const secs = Math.floor((uptime / 1000) % 60);

  res.send({
    status: "ok",
    whatsapp: sock?.user ? "connected" : "disconnected",
    uptime: `${days}d ${hours}h ${mins}m ${secs}s`,
    logs: logs.length,
  });
});

/* ------------------------------
   🌐 WEB DASHBOARD (WITH GROUP EXTRACTOR)
------------------------------ */
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
 <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Multi-Target Bot</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 1100px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.2);
            padding: 30px;
        }
        h1 {
            color: #667eea;
            text-align: center;
            margin-bottom: 10px;
            font-size: 32px;
        }
        .subtitle {
            text-align: center;
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid #e1e5e9;
        }
        .tab {
            padding: 12px 24px;
            background: transparent;
            border: none;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            color: #666;
            border-bottom: 3px solid transparent;
            transition: all 0.3s;
        }
        .tab.active {
            color: #667eea;
            border-bottom-color: #667eea;
        }
        .tab-content {
            display: none;
        }
        .tab-content.active {
            display: block;
        }
        .section {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
        }
        .section h3 {
            color: #333;
            margin-bottom: 15px;
            font-size: 18px;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
        }
        .form-group {
            margin-bottom: 15px;
        }
        label {
            display: block;
            font-weight: 600;
            margin-bottom: 5px;
            color: #333;
            font-size: 14px;
        }
        input, textarea {
            width: 100%;
            padding: 12px;
            border: 2px solid #e1e5e9;
            border-radius: 6px;
            font-size: 14px;
            font-family: inherit;
        }
        input:focus, textarea:focus {
            outline: none;
            border-color: #667eea;
        }
        textarea {
            min-height: 80px;
            resize: vertical;
            font-family: 'Courier New', monospace;
        }
        .help-text {
            font-size: 12px;
            color: #666;
            margin-top: 5px;
            font-style: italic;
        }
        .btn-group {
            display: flex;
            gap: 10px;
            margin-top: 15px;
        }
        button {
            flex: 1;
            padding: 12px;
            border: none;
            border-radius: 6px;
            font-size: 15px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.3s;
        }
        .btn-primary {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
        }
        .btn-success {
            background: linear-gradient(135deg, #4CAF50, #45a049);
            color: white;
        }
        .btn-danger {
            background: linear-gradient(135deg, #f44336, #da190b);
            color: white;
        }
        .btn-info {
            background: linear-gradient(135deg, #2196F3, #0b7dda);
            color: white;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }
        .status-box {
            background: white;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 15px;
        }
        .status-item {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #f0f0f0;
        }
        .status-item:last-child {
            border-bottom: none;
        }
        .status-item strong {
            color: #555;
        }
        .status-value {
            font-weight: 600;
            color: #333;
        }
        .status-connected {
            color: #4CAF50;
        }
        .status-disconnected {
            color: #f44336;
        }
        #logs {
            background: #1e1e1e;
            color: #00ff00;
            padding: 15px;
            border-radius: 8px;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            max-height: 300px;
            overflow-y: auto;
            line-height: 1.6;
        }
        .log-entry {
            margin-bottom: 5px;
        }
        .log-time {
            color: #888;
            margin-right: 10px;
        }
        #pairingCode {
            font-size: 24px;
            font-weight: bold;
            color: #667eea;
            text-align: center;
            padding: 20px;
            background: #f0f4ff;
            border-radius: 8px;
            margin-top: 15px;
            display: none;
            letter-spacing: 3px;
        }
        .groups-list {
            max-height: 400px;
            overflow-y: auto;
            background: white;
            padding: 10px;
            border-radius: 8px;
            margin-top: 15px;
        }
        .group-item {
            padding: 12px;
            margin: 5px 0;
            background: #f9f9f9;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
            border-left: 4px solid #667eea;
        }
        .group-item:hover {
            background: #e3f2fd;
            transform: translateX(5px);
        }
        .group-item.selected {
            background: #bbdefb;
            border-left-color: #2196F3;
        }
        .group-name {
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
        }
        .group-id {
            font-family: 'Courier New', monospace;
            font-size: 11px;
            color: #666;
            background: #f5f5f5;
            padding: 4px 8px;
            border-radius: 4px;
            display: inline-block;
        }
        .group-info {
            font-size: 12px;
            color: #999;
            margin-top: 5px;
        }
        .loading {
            text-align: center;
            padding: 20px;
            color: #667eea;
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📱 WhatsApp Multi-Target Bot</h1>
        <div class="subtitle">Send messages to multiple numbers/groups + Extract Group IDs</div>

        <!-- TABS -->
        <div class="tabs">
            <button class="tab active" onclick="switchTab('status')">📊 Status</button>
            <button class="tab" onclick="switchTab('pairing')">🔗 Pairing</button>
            <button class="tab" onclick="switchTab('extractor')">🔍 Group Extractor</button>
            <button class="tab" onclick="switchTab('sender')">📤 Message Sender</button>
            <button class="tab" onclick="switchTab('logs')">📜 Logs</button>
        </div>

        <!-- STATUS TAB -->
        <div id="status-tab" class="tab-content active">
            <div class="section">
                <h3>📊 System Status</h3>
                <div class="status-box">
                    <div class="status-item">
                        <strong>WhatsApp Connection:</strong>
                        <span class="status-value" id="waStatus">Checking...</span>
                    </div>
                    <div class="status-item">
                        <strong>Bot Status:</strong>
                        <span class="status-value" id="botStatus">Idle</span>
                    </div>
                    <div class="status-item">
                        <strong>Server Uptime:</strong>
                        <span class="status-value" id="uptime">-</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- PAIRING TAB -->
        <div id="pairing-tab" class="tab-content">
            <div class="section">
                <h3>🔗 WhatsApp Pairing</h3>
                <div class="form-group">
                    <label>Phone Number (with country code)</label>
                    <input type="text" id="pairNumber" placeholder="923001234567" />
                    <div class="help-text">Enter number without + or spaces (e.g., 923001234567)</div>
                </div>
                <button class="btn-primary" onclick="requestPairing()">🔑 Get Pairing Code</button>
                <div id="pairingCode"></div>
            </div>
        </div>

        <!-- GROUP EXTRACTOR TAB -->
        <div id="extractor-tab" class="tab-content">
            <div class="section">
                <h3>🔍 Group UID Extractor</h3>
                <p style="margin-bottom:15px; color:#666;">Extract all group IDs you're member of</p>
                
                <button class="btn-info" onclick="extractGroups()" style="width:100%;">🔍 Extract All Groups</button>
                
                <div id="extractorStatus" style="display:none;" class="loading">
                    Extracting groups...
                </div>

                <div id="groupsContainer" style="display:none;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:15px; margin-bottom:10px;">
                        <h4 style="color:#667eea;">📍 Found Groups (<span id="groupCount">0</span>)</h4>
                        <button class="btn-success" onclick="copySelectedGroups()" style="flex:none; padding:8px 16px;">
                            📋 Copy Selected (<span id="selectedCount">0</span>)
                        </button>
                    </div>
                    <div class="groups-list" id="groupsList"></div>
                    <button class="btn-info" onclick="copyAllGroups()" style="width:100%; margin-top:10px;">
                        📋 Copy All Group IDs
                    </button>
                </div>
            </div>
        </div>

        <!-- MESSAGE SENDER TAB -->
        <div id="sender-tab" class="tab-content">
            <div class="section">
                <h3>📤 Message Configuration</h3>
                
                <div class="form-group">
                    <label>Target Numbers/Groups (comma separated)</label>
                    <textarea id="targets" placeholder="923001234567, 923009876543, 120363123456789012@g.us"></textarea>
                    <div class="help-text">For groups, use: groupid@g.us | For numbers: countrycode+number</div>
                </div>

                <div class="form-group">
                    <label>Delay Between Messages (milliseconds)</label>
                    <input type="number" id="delay" value="3000" min="1500" />
                    <div class="help-text">Minimum 1500ms recommended to avoid bans</div>
                </div>

                <div class="form-group">
                    <label>Prefix Text (Optional)</label>
                    <input type="text" id="haterName" placeholder="[BOT]" />
                    <div class="help-text">Will be added before each message</div>
                </div>

                <div class="btn-group">
                    <button class="btn-success" onclick="startSending()">▶️ Start Sending</button>
                    <button class="btn-danger" onclick="stopSending()">⏹️ Stop</button>
                </div>
            </div>
        </div>

        <!-- LOGS TAB -->
        <div id="logs-tab" class="tab-content">
            <div class="section">
                <h3>📜 Live Logs</h3>
                <div id="logs">
                    <div class="log-entry">Waiting for logs...</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let allGroups = [];
        let selectedGroups = new Set();

        // Tab Switching
        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById(tabName + '-tab').classList.add('active');
        }

        // Connect to Server-Sent Events for real-time logs
        const eventSource = new EventSource('/logs');
        const logsDiv = document.getElementById('logs');

        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            const time = new Date(data.time).toLocaleTimeString();
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            entry.innerHTML = \`<span class="log-time">[\${time}]</span>\${data.message}\`;
            logsDiv.appendChild(entry);
            logsDiv.scrollTop = logsDiv.scrollHeight;

            while (logsDiv.children.length > 50) {
                logsDiv.removeChild(logsDiv.firstChild);
            }
        };

        // Update status every 3 seconds
        setInterval(updateStatus, 3000);
        updateStatus();

        async function updateStatus() {
            try {
                const res = await fetch('/health');
                const data = await res.json();
                
                document.getElementById('waStatus').textContent = data.whatsapp;
                document.getElementById('waStatus').className = 
                    'status-value ' + (data.whatsapp === 'connected' ? 'status-connected' : 'status-disconnected');
                
                document.getElementById('uptime').textContent = data.uptime;
            } catch (err) {
                document.getElementById('waStatus').textContent = 'Error';
                document.getElementById('waStatus').className = 'status-value status-disconnected';
            }
        }

        async function requestPairing() {
            const number = document.getElementById('pairNumber').value.trim();
            if (!number) {
                alert('❌ Please enter a phone number!');
                return;
            }

            const codeDiv = document.getElementById('pairingCode');
            codeDiv.textContent = 'Generating code...';
            codeDiv.style.display = 'block';

            try {
                const res = await fetch('/pair', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ number })
                });

                const data = await res.json();
                
                if (data.code) {
                    codeDiv.textContent = \`Pairing Code: \${data.code}\`;
                    alert(\`✅ Pairing code generated!\\n\\nCode: \${data.code}\\n\\nEnter this code in WhatsApp:\\nSettings → Linked Devices → Link a Device → Link with Phone Number\`);
                } else {
                    codeDiv.textContent = 'Failed to generate code';
                    alert('❌ Error: ' + (data.error || 'Unknown error'));
                }
            } catch (err) {
                codeDiv.textContent = 'Error: ' + err.message;
                alert('❌ Error: ' + err.message);
            }
        }

        async function extractGroups() {
            const statusDiv = document.getElementById('extractorStatus');
            const container = document.getElementById('groupsContainer');
            
            statusDiv.style.display = 'block';
            container.style.display = 'none';
            selectedGroups.clear();

            try {
                const res = await fetch('/extract-groups');
                const data = await res.json();

                if (data.success && data.groups.length > 0) {
                    allGroups = data.groups;
                    displayGroups(data.groups);
                    container.style.display = 'block';
                    document.getElementById('groupCount').textContent = data.count;
                    alert(\`✅ Found \${data.count} groups!\\n\\nClick on groups to select them, then copy their IDs.\`);
                } else {
                    alert('❌ No groups found or WhatsApp not connected!');
                }
            } catch (err) {
                alert('❌ Error: ' + err.message);
            } finally {
                statusDiv.style.display = 'none';
            }
        }

        function displayGroups(groups) {
            const list = document.getElementById('groupsList');
            list.innerHTML = groups.map((g, i) => \`
                <div class="group-item" id="group-\${i}" onclick="toggleGroup(\${i})">
                    <div class="group-name">\${g.name}</div>
                    <div class="group-id">\${g.id}</div>
                    <div class="group-info">
                        👥 \${g.participants} members | 👤 Owner: \${g.owner} | 📅 Created: \${g.created}
                    </div>
                </div>
            \`).join('');
        }

        function toggleGroup(index) {
            const elem = document.getElementById(\`group-\${index}\`);
            const groupId = allGroups[index].id;

            if (selectedGroups.has(groupId)) {
                selectedGroups.delete(groupId);
                elem.classList.remove('selected');
            } else {
                selectedGroups.add(groupId);
                elem.classList.add('selected');
            }

            document.getElementById('selectedCount').textContent = selectedGroups.size;
        }

        function copySelectedGroups() {
            if (selectedGroups.size === 0) {
                alert('❌ Please select at least one group!');
                return;
            }

            const ids = Array.from(selectedGroups).join(', ');
            navigator.clipboard.writeText(ids);
            alert(\`✅ Copied \${selectedGroups.size} group IDs!\\n\\nYou can now paste them in the Message Sender tab.\`);
        }

        function copyAllGroups() {
            if (allGroups.length === 0) {
                alert('❌ No groups to copy!');
                return;
            }

            const ids = allGroups.map(g => g.id).join(', ');
            navigator.clipboard.writeText(ids);
            alert(\`✅ Copied all \${allGroups.length} group IDs!\\n\\nYou can now paste them in the Message Sender tab.\`);
        }

        async function startSending() {
            const targets = document.getElementById('targets').value.trim();
            const delay = document.getElementById('delay').value;
            const haterName = document.getElementById('haterName').value.trim();

            if (!targets) {
                alert('❌ Please enter target numbers/groups!');
                return;
            }

            if (parseInt(delay) < 1500) {
                alert('⚠️ Delay too short! Minimum 1500ms recommended.');
                return;
            }

            if (!confirm(\`Start sending messages to:\\n\${targets}\\n\\nDelay: \${delay}ms\\n\\nContinue?\`)) {
                return;
            }

            try {
                const res = await fetch('/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targets, delay: parseInt(delay), haterName })
                });

                const data = await res.json();
                
                if (data.status === 'started') {
                    document.getElementById('botStatus').textContent = '🟢 Sending';
                    alert(\`✅ Started sending to \${data.targets.length} targets!\\n\\nDelay: \${data.delay}ms\`);
                } else {
                    alert('❌ Error: ' + (data.error || 'Unknown error'));
                }
            } catch (err) {
                alert('❌ Error: ' + err.message);
            }
        }

        async function stopSending() {
            if (!confirm('Stop sending messages?')) return;

            try {
                const res = await fetch('/stop', { method: 'POST' });
                const data = await res.json();
                
                document.getElementById('botStatus').textContent = 'Idle';
                alert('⏹️ Sending stopped!');
            } catch (err) {
                alert('❌ Error: ' + err.message);
            }
        }
    </script>
</body>
</html>
  `);
});

/* ------------------------------
   🚀 Start Server
------------------------------ */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🌍 WhatsApp Multi-Target Bot + Group Extractor`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`📡 Dashboard: http://0.0.0.0:${PORT}`);
  console.log(`🔗 Pairing API: POST /pair`);
  console.log(`🔍 Extract Groups: GET /extract-groups`);
  console.log(`📤 Start API: POST /start`);
  console.log(`🛑 Stop API: POST /stop`);
  console.log(`💚 Health API: GET /health`);
  console.log(`\n🎯 FEATURES:`);
  console.log(`   ✅ WhatsApp Pairing (No QR Code)`);
  console.log(`   ✅ Group UID Extractor`);
  console.log(`   ✅ Multi-Target Messaging`);
  console.log(`   ✅ Real-time Logs (SSE)`);
  console.log(`   ✅ Auto-Clean Auth Files`);
  console.log(`${'═'.repeat(70)}\n`);
  
  connectWhatsApp();
});
