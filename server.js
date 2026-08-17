import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import crypto from 'crypto';
import os from 'os';
import archiver from 'archiver';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';

let sleepPreventerProcess = null;
const chatHistory = [];
const MAX_CHAT_HISTORY = 50;

let currentFilename = '';
let currentDirname = '';
try {
  currentFilename = fileURLToPath(import.meta.url);
  currentDirname = path.dirname(currentFilename);
} catch (e) {
  currentFilename = __filename;
  currentDirname = __dirname;
}
const __filename = currentFilename;
const __dirname = currentDirname;

const PORT = process.env.PORT || 3000;
const appDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const UPLOADS_DIR = path.resolve(path.join(appDir, 'uploads'));
const TEMP_DIR = path.resolve(path.join(appDir, 'uploads_temp'));

// Ensure clean directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Configuration & State
const SERVER_PIN = Math.floor(100000 + Math.random() * 900000).toString();
const VALID_TOKENS = new Set();
const STARTUP_TOKEN = crypto.randomBytes(16).toString('hex');
VALID_TOKENS.add(STARTUP_TOKEN);

// Docker-style scientist naming pool (20 adjectives * 20 scientists = 400 combinations)
const ADJECTIVES = [
  'focused', 'quirky', 'pensive', 'clever', 'dazzling',
  'jolly', 'vibrant', 'serene', 'bold', 'friendly',
  'elated', 'mindful', 'agile', 'sleepy', 'speedy',
  'epic', 'radiant', 'witty', 'brave', 'mystic'
];

const NAMES = [
  'curie', 'hawking', 'turing', 'einstein', 'tesla',
  'lovelace', 'hopper', 'franklin', 'pasteur', 'darwin',
  'galileo', 'newton', 'bohr', 'mendel', 'mendeleev',
  'raman', 'bose', 'bell', 'faraday', 'sagan'
];

function generateClientName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const name = NAMES[Math.floor(Math.random() * NAMES.length)];
  return `${adj}_${name}`;
}

const REMEMBERED_CLIENTS_FILE = path.resolve(path.join(appDir, 'remembered_clients.json'));
let rememberedClients = new Map();
try {
  if (fs.existsSync(REMEMBERED_CLIENTS_FILE)) {
    const fileData = JSON.parse(fs.readFileSync(REMEMBERED_CLIENTS_FILE, 'utf8'));
    rememberedClients = new Map(Object.entries(fileData));
  }
} catch (err) {
  console.error('Failed to load remembered clients:', err);
}

function saveRememberedClients() {
  try {
    const obj = Object.fromEntries(rememberedClients);
    fs.writeFileSync(REMEMBERED_CLIENTS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save remembered clients:', err);
  }
}

// Temporary in-memory client session names
const tempClientNames = new Map();

// Express Application Setup
const app = express();
app.use(express.json());

// Serve Static Frontend Assets (except uploads)
const staticDir = process.pkg ? path.join(__dirname, '..', 'public') : path.join(__dirname, 'public');
app.use(express.static(staticDir));

// Authentication Helper Middleware
const authenticate = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1] || req.query.token;
  if (!token || (!VALID_TOKENS.has(token) && !rememberedClients.has(token))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// --- REST API ENDPOINTS ---

// Check if authentication token is valid
app.get('/api/auth/verify', (req, res) => {
  const token = req.query.token;
  if (token && (VALID_TOKENS.has(token) || rememberedClients.has(token))) {
    return res.json({ valid: true });
  }
  res.json({ valid: false });
});

// Authenticate via PIN
app.post('/api/auth', (req, res) => {
  const { pin, remember, userAgent } = req.body;
  if (pin === SERVER_PIN) {
    const token = crypto.randomBytes(16).toString('hex');
    VALID_TOKENS.add(token);
    
    let name = generateClientName();
    const existingNames = new Set(Array.from(rememberedClients.values()).map(c => c.name));
    let attempts = 0;
    while (existingNames.has(name) && attempts < 100) {
      name = generateClientName();
      attempts++;
    }

    if (remember) {
      rememberedClients.set(token, {
        name,
        deviceInfo: {
          userAgent: userAgent || 'Unknown Device',
          ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1').replace('::ffff:', ''),
          connectedAt: new Date().toISOString()
        }
      });
      saveRememberedClients();
    } else {
      tempClientNames.set(token, name);
    }
    
    return res.json({ token, name });
  }
  res.status(401).json({ error: 'Invalid PIN' });
});

// Get recursively mapped file and folder metadata structure
app.get('/api/files', authenticate, async (req, res) => {
  try {
    const filesList = await scanDirectory(UPLOADS_DIR);
    res.json(filesList);
  } catch (error) {
    console.error('Failed to list files:', error);
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

// Delete files/folders
app.delete('/api/delete', authenticate, async (req, res) => {
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'Path is required' });

  const targetPath = path.resolve(path.join(UPLOADS_DIR, relPath));
  
  // Security check: prevent directory traversal outside uploads
  if (!targetPath.startsWith(UPLOADS_DIR)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    if (fs.existsSync(targetPath)) {
      await fsp.rm(targetPath, { recursive: true, force: true });
      broadcastFileList();
      res.json({ message: 'Deleted successfully' });
    } else {
      res.status(404).json({ error: 'File or folder not found' });
    }
  } catch (err) {
    console.error('Failed to delete:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// Handle Chunked Uploads
app.post('/api/upload/chunk', authenticate, async (req, res) => {
  const fileId = req.headers['x-file-id'];
  const fileName = req.headers['x-file-name']; // raw original relative path
  const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);
  const totalChunks = parseInt(req.headers['x-total-chunks'], 10);

  if (!fileId || !fileName || isNaN(chunkIndex) || isNaN(totalChunks)) {
    return res.status(400).json({ error: 'Missing chunk upload headers' });
  }

  const decodedFileName = decodeURIComponent(fileName);
  // Sanitize path to prevent directory traversal
  const safeRelativePath = path.normalize(decodedFileName).replace(/^(\.\.(\/|\\|$))+/, '');
  const fileTempDir = path.join(TEMP_DIR, fileId);

  try {
    if (!fs.existsSync(fileTempDir)) {
      await fsp.mkdir(fileTempDir, { recursive: true });
    }

    if (chunkIndex === 0) {
      console.log(`[ACTIVITY] Upload started: "${safeRelativePath}"`);
      broadcastActivity({ type: 'upload_started', file: safeRelativePath });
    }

    const chunkFilePath = path.join(fileTempDir, `chunk_${chunkIndex}`);
    const writeStream = fs.createWriteStream(chunkFilePath);
    req.pipe(writeStream);

    writeStream.on('error', (err) => {
      console.error('Error writing chunk file:', err);
      console.log(`[ACTIVITY] Upload failed: "${safeRelativePath}"`);
      broadcastActivity({ type: 'upload_failed', file: safeRelativePath });
      res.status(500).json({ error: 'Failed to write chunk data' });
    });

    writeStream.on('finish', async () => {
      try {
        const files = await fsp.readdir(fileTempDir);
        if (files.length === totalChunks) {
          // All chunks uploaded: assemble!
          const finalFilePath = path.join(UPLOADS_DIR, safeRelativePath);
          const finalFileDir = path.dirname(finalFilePath);
          
          if (!fs.existsSync(finalFileDir)) {
            await fsp.mkdir(finalFileDir, { recursive: true });
          }

          await mergeChunks(fileTempDir, totalChunks, finalFilePath);
          await fsp.rm(fileTempDir, { recursive: true, force: true });
          
          console.log(`[ACTIVITY] Upload finished: "${safeRelativePath}"`);
          broadcastActivity({ type: 'upload_finished', file: safeRelativePath });

          broadcastFileList();
          res.json({ status: 'completed', path: safeRelativePath });
        } else {
          res.json({ status: 'chunk_saved', chunkIndex });
        }
      } catch (err) {
        console.error('Error post-processing chunks:', err);
        res.status(500).json({ error: 'Failed to assemble file chunks' });
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Download files or folders (folders are zipped on the fly)
app.get('/api/download', authenticate, async (req, res) => {
  const relPath = req.query.path;
  if (!relPath) return res.status(400).send('Path is required');

  const targetPath = path.resolve(path.join(UPLOADS_DIR, relPath));

  // Security check: prevent directory traversal
  if (!targetPath.startsWith(UPLOADS_DIR)) {
    return res.status(403).send('Access denied');
  }

  if (!fs.existsSync(targetPath)) {
    return res.status(404).send('File or folder not found');
  }

  const targetName = path.basename(targetPath);
  console.log(`[ACTIVITY] Download started: "${targetName}"`);
  broadcastActivity({ type: 'download_started', file: targetName });

  res.on('finish', () => {
    console.log(`[ACTIVITY] Download finished: "${targetName}"`);
    broadcastActivity({ type: 'download_finished', file: targetName });
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      console.log(`[ACTIVITY] Download aborted: "${targetName}"`);
      broadcastActivity({ type: 'download_aborted', file: targetName });
    }
  });

  try {
    const stat = await fsp.stat(targetPath);

    if (stat.isDirectory()) {
      // Folder: zip on the fly and stream
      const folderName = path.basename(targetPath);
      res.attachment(`${folderName}.zip`);
      res.setHeader('Content-Type', 'application/zip');

      const archive = archiver('zip', { zlib: { level: 6 } });
      
      archive.on('error', (err) => {
        console.error('Zipping error:', err);
        if (!res.headersSent) {
          res.status(500).send('Zipping failed');
        }
      });

      req.on('close', () => {
        // Handle aborts gracefully
        archive.abort();
      });

      archive.pipe(res);
      archive.directory(targetPath, folderName);
      await archive.finalize();
    } else {
      // File: stream directly
      res.download(targetPath, path.basename(targetPath));
    }
  } catch (err) {
    console.error('Download processing failed:', err);
    if (!res.headersSent) {
      res.status(500).send('Failed to serve download request');
    }
  }
});

// Get server info (port, PIN, and local network IP addresses)
app.get('/api/server-info', authenticate, async (req, res) => {
  const hostname = os.hostname();
  const interfaces = os.networkInterfaces();
  const addresses = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(`http://${iface.address}:${PORT}`);
      }
    }
  }

  const token = req.headers['authorization']?.split(' ')[1] || req.query.token;
  const isServer = token === STARTUP_TOKEN;

  res.json({ 
    hostname, 
    port: PORT, 
    pin: SERVER_PIN, 
    addresses,
    isServer
  });
});

// Helper: Merge files sequentially with minimal memory footprint
async function mergeChunks(tempDir, totalChunks, outputPath) {
  const finalWriteStream = fs.createWriteStream(outputPath);
  
  for (let i = 0; i < totalChunks; i++) {
    const chunkFile = path.join(tempDir, `chunk_${i}`);
    await new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(chunkFile);
      readStream.pipe(finalWriteStream, { end: false });
      readStream.on('end', resolve);
      readStream.on('error', reject);
    });
  }
  
  finalWriteStream.end();
  return new Promise((resolve, reject) => {
    finalWriteStream.on('finish', resolve);
    finalWriteStream.on('error', reject);
  });
}

// Helper: Scan folder structure recursively
async function scanDirectory(dir) {
  const results = [];
  const list = await fsp.readdir(dir, { withFileTypes: true });
  
  for (const item of list) {
    const fullPath = path.join(dir, item.name);
    const relativePath = path.relative(UPLOADS_DIR, fullPath).replace(/\\/g, '/');
    const stat = await fsp.stat(fullPath);

    if (item.isDirectory()) {
      results.push({
        name: item.name,
        path: relativePath,
        type: 'directory',
        size: await getDirectorySize(fullPath),
        mtime: stat.mtime
      });
    } else {
      results.push({
        name: item.name,
        path: relativePath,
        type: 'file',
        size: stat.size,
        mtime: stat.mtime
      });
    }
  }
  // Sort: directories first, then files alphabetically
  return results.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// Helper: Get folder size recursively
async function getDirectorySize(dir) {
  let size = 0;
  const list = await fsp.readdir(dir, { withFileTypes: true });
  for (const item of list) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      size += await getDirectorySize(fullPath);
    } else {
      const stat = await fsp.stat(fullPath);
      size += stat.size;
    }
  }
  return size;
}

// --- CREATE SERVER AND WEBSOCKET ---

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket authentication handshake
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token || (!VALID_TOKENS.has(token) && !rememberedClients.has(token))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isServer = (token === STARTUP_TOKEN);
    ws.clientToken = token;
    wss.emit('connection', ws, req);
  });
});

const clients = new Set();

wss.on('connection', (ws, req) => {
  // Capture device metadata
  const userAgent = req.headers['user-agent'] || 'Unknown Device';
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
  
  ws.deviceInfo = {
    userAgent,
    ip: ip.replace('::ffff:', ''), // normalize IPv6-mapped IPv4
    connectedAt: new Date().toISOString()
  };

  // Assign client name
  let clientName = 'Host';
  if (!ws.isServer) {
    if (rememberedClients.has(ws.clientToken)) {
      clientName = rememberedClients.get(ws.clientToken).name;
    } else {
      if (!tempClientNames.has(ws.clientToken)) {
        let name = generateClientName();
        const existingNames = new Set([
          ...Array.from(rememberedClients.values()).map(c => c.name),
          ...Array.from(tempClientNames.values())
        ]);
        let attempts = 0;
        while (existingNames.has(name) && attempts < 100) {
          name = generateClientName();
          attempts++;
        }
        tempClientNames.set(ws.clientToken, name);
      }
      clientName = tempClientNames.get(ws.clientToken);
    }
  }
  ws.clientName = clientName;

  clients.add(ws);
  broadcastConnectionsCount();
  
  // Send current state to newly connected client
  ws.send(JSON.stringify({ type: 'assigned_name', name: ws.clientName }));
  ws.send(JSON.stringify({ type: 'chat_history', data: chatHistory }));
  sendFileList(ws);

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'chat') {
        let deviceOS = 'Device';
        if (ws.isServer) {
          deviceOS = 'Host';
        } else {
          const ua = (ws.deviceInfo?.userAgent || '').toLowerCase();
          if (ua.includes('android')) deviceOS = 'Android';
          else if (ua.includes('iphone')) deviceOS = 'iPhone';
          else if (ua.includes('ipad')) deviceOS = 'iPad';
          else if (ua.includes('macintosh') || ua.includes('mac os')) deviceOS = 'Mac';
          else if (ua.includes('windows')) deviceOS = 'Windows';
          else if (ua.includes('linux')) deviceOS = 'Linux';
        }

        const chatMsg = {
          text: parsed.text,
          sender: parsed.sender || 'Unknown Device',
          timestamp: parsed.timestamp || new Date().toISOString(),
          isServer: !!ws.isServer,
          deviceOS: deviceOS,
          ip: ws.isServer ? '127.0.0.1' : (ws.deviceInfo?.ip || 'Unknown IP')
        };
        chatHistory.push(chatMsg);
        if (chatHistory.length > MAX_CHAT_HISTORY) {
          chatHistory.shift();
        }
        // Broadcast to all clients
        broadcast({ type: 'chat', data: chatMsg });
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastConnectionsCount();
  });
});

// Broadcast utilities
function broadcast(payload, excludeWs = null) {
  const data = JSON.stringify(payload);
  clients.forEach((client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function broadcastConnectionsCount() {
  const devicesList = Array.from(clients).map((client, idx) => {
    return {
      id: (client.deviceInfo?.ip || 'unknown') + '-' + idx,
      ip: client.deviceInfo?.ip || 'Unknown IP',
      userAgent: client.deviceInfo?.userAgent || 'Unknown User Agent',
      connectedAt: client.deviceInfo?.connectedAt || new Date().toISOString(),
      name: client.clientName || 'Unknown Device',
      isServer: !!client.isServer
    };
  });

  // Broadcast connections list only to Server (host) connection
  clients.forEach((client) => {
    if (client.isServer && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ 
        type: 'connections', 
        count: clients.size,
        devices: devicesList
      }));
    } else if (client.readyState === WebSocket.OPEN) {
      // Clients only receive count
      client.send(JSON.stringify({ 
        type: 'connections', 
        count: clients.size 
      }));
    }
  });
}

function broadcastActivity(activity) {
  broadcast({ type: 'activity', data: activity });
}

async function sendFileList(ws) {
  try {
    const list = await scanDirectory(UPLOADS_DIR);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'file_list', data: list }));
    }
  } catch (err) {
    console.error('WebSocket send file list failed:', err);
  }
}

async function broadcastFileList() {
  try {
    const list = await scanDirectory(UPLOADS_DIR);
    broadcast({ type: 'file_list', data: list });
  } catch (err) {
    console.error('Broadcast file list failed:', err);
  }
}

// Log startup details
server.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  addresses.push(`http://localhost:${PORT}`);
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(`http://${iface.address}:${PORT}`);
      }
    }
  }

  console.clear();
  console.log('========================================================');
  console.log('      🚀 LOCAL NETWORK SECURE FILE TRANSFER SERVER 🚀    ');
  console.log('========================================================\n');
  console.log(`🔐 ACCESS PIN: ${SERVER_PIN}`);
  console.log('\n🔗 Connection Links:');
  addresses.forEach((address) => {
    console.log(`   - ${address}/?token=${STARTUP_TOKEN} (Auto-login)`);
    console.log(`   - ${address} (Needs PIN)`);
  });
  console.log('\n========================================================');

  // Open default browser on startup pointing to local autologin page
  openBrowser(`http://localhost:${PORT}/?token=${STARTUP_TOKEN}`);

  // Prevent Windows system sleep while hosting
  preventSleep();
});

// Helper: Open default browser in a cross-platform manner
function openBrowser(url) {
  const startCommand = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : `${startCommand} "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.error('Failed to open browser:', err);
    }
  });
}

// Helper: Prevent system sleep on Windows
function preventSleep() {
  if (process.platform !== 'win32') return;

  const script = `
    $code = @'
    using System;
    using System.Runtime.InteropServices;
    public class SleepUtil {
        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern uint SetThreadExecutionState(uint esFlags);
    }
'@
    Add-Type -TypeDefinition $code
    # 0x80000001: ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    [SleepUtil]::SetThreadExecutionState(0x80000001)
    write-output "Sleep prevention active"
    Start-Sleep -Seconds 9999999
  `;

  try {
    sleepPreventerProcess = spawn('powershell', ['-NoProfile', '-Command', script]);
    sleepPreventerProcess.stdout.on('data', (data) => {
      console.log('PowerShell:', data.toString().trim());
    });
    sleepPreventerProcess.on('error', (err) => {
      console.error('Failed to start sleep preventer:', err);
    });
  } catch (err) {
    console.error('Error starting sleep preventer:', err);
  }
}

// Graceful cleanup on exit
process.on('SIGINT', async () => {
  console.log('\nCleaning up and shutting down...');
  if (sleepPreventerProcess) {
    try {
      sleepPreventerProcess.kill();
    } catch (e) {}
  }
  try {
    if (fs.existsSync(TEMP_DIR)) {
      await fsp.rm(TEMP_DIR, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Cleanup on exit failed:', e);
  }
  process.exit();
});
