// State Variables
let token = sessionStorage.getItem('localdrop_token') || localStorage.getItem('localdrop_token') || '';
let ws = null;
let reconnectInterval = 3000;
let isServer = false;
let lastConnectionCount = 0;
let connectedDevices = [];
let clientName = '';
const activeDownloads = new Map();
let totalUploadBatchFiles = 0;
let completedUploadBatchFiles = 0;

// Concurrency upload queue state
const uploadQueue = [];
let activeUploadCount = 0;
const MAX_CONCURRENT_UPLOADS = 3;
const activeUploads = new Map(); // fileId -> state metadata

// UI DOM elements
const authScreen = document.getElementById('auth-screen');
const appScreen = document.getElementById('app-screen');
const authForm = document.getElementById('auth-form');
const pinInput = document.getElementById('pin-input');
const authBtn = document.getElementById('auth-btn');
const authError = document.getElementById('auth-error');

const connectionStatus = document.getElementById('connection-status');
const serverAddress = document.getElementById('server-address');
const ipInfoBox = document.getElementById('ip-info-box');
const logoutBtn = document.getElementById('logout-btn');
const refreshBtn = document.getElementById('refresh-btn');

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const folderInput = document.getElementById('folder-input');

const transferCard = document.getElementById('transfer-card');
const transferCount = document.getElementById('transfer-count');
const transferQueue = document.getElementById('transfer-queue');

const emptyState = document.getElementById('empty-state');
const filesList = document.getElementById('files-list');

// --- INITIALIZATION ---

document.addEventListener('DOMContentLoaded', () => {
  // Parse token from URL query string (for auto-login from server CLI)
  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = urlParams.get('token');

  if (urlToken) {
    token = urlToken;
    sessionStorage.setItem('localdrop_token', urlToken);
    // Clean URL query string
    const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
  }

  if (token) {
    verifyToken();
  } else {
    showScreen('auth-screen');
  }

  setupEventListeners();
  // Initialize Lucide Icons
  lucide.createIcons();
});

// Verify if the session token is valid
async function verifyToken() {
  try {
    const response = await fetch(`/api/auth/verify?token=${token}`);
    const result = await response.json();
    if (result.valid) {
      showScreen('app-screen');
      initializeDashboard();
    } else {
      clearSession();
    }
  } catch (error) {
    console.error('Failed to verify token:', error);
    showToast('Failed to reach server. Trying local connection.', 'error');
    // If server is unreachable but we have token, we can try to initialize anyway
    showScreen('app-screen');
    initializeDashboard();
  }
}

function clearSession() {
  token = '';
  clientName = '';
  sessionStorage.removeItem('localdrop_token');
  localStorage.removeItem('localdrop_token');
  showScreen('auth-screen');
  if (ws) {
    ws.close();
    ws = null;
  }
}

function showScreen(screenId) {
  authScreen.classList.remove('active');
  appScreen.classList.remove('active');
  authScreen.style.display = 'none';
  appScreen.style.display = 'none';

  const target = document.getElementById(screenId);
  target.style.display = screenId === 'auth-screen' ? 'flex' : 'flex';
  // Force reflow
  target.offsetHeight;
  target.classList.add('active');
}

// Setup Event Listeners
function setupEventListeners() {
  // Authentication submission
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = pinInput.value.trim();
    const remember = document.getElementById('remember-me-checkbox')?.checked || false;
    
    if (pin.length !== 6) {
      showAuthError('PIN must be 6 digits.');
      return;
    }

    authBtn.disabled = true;
    authBtn.querySelector('span').innerText = 'Connecting...';

    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, remember, userAgent: navigator.userAgent })
      });

      if (response.ok) {
        const data = await response.json();
        token = data.token;
        clientName = data.name;
        sessionStorage.setItem('localdrop_token', token);
        if (remember) {
          localStorage.setItem('localdrop_token', token);
        }
        showScreen('app-screen');
        initializeDashboard();
      } else {
        const data = await response.json();
        showAuthError(data.error || 'Connection failed.');
      }
    } catch (err) {
      console.error('Auth error:', err);
      showAuthError('Failed to connect to the server.');
    } finally {
      authBtn.disabled = false;
      authBtn.querySelector('span').innerText = 'Connect Session';
    }
  });

  // Logout click
  logoutBtn.addEventListener('click', clearSession);

  // Connection pill click to open modal (server only)
  const connectionPill = document.querySelector('.connection-pill');
  if (connectionPill) {
    connectionPill.addEventListener('click', () => {
      if (isServer) {
        openDevicesModal();
      }
    });
  }

  // Manual Refresh click
  refreshBtn.addEventListener('click', () => {
    refreshBtn.classList.add('spinning');
    fetchFileList().finally(() => {
      setTimeout(() => refreshBtn.classList.remove('spinning'), 500);
    });
  });

  // Server Info / IP Copy Click
  ipInfoBox.addEventListener('click', () => {
    const addressText = serverAddress.innerText;
    navigator.clipboard.writeText(addressText)
      .then(() => showToast('Server link copied to clipboard!', 'success'))
      .catch(() => showToast('Failed to copy link', 'error'));
  });

  // File & Folder input triggers
  fileInput.addEventListener('change', (e) => {
    handleSelectedFiles(e.target.files);
    fileInput.value = ''; // clear input
  });

  folderInput.addEventListener('change', (e) => {
    handleSelectedFiles(e.target.files);
    folderInput.value = ''; // clear input
  });

  // Chat form submit
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  if (chatForm && chatInput) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (!text) return;

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'chat',
          text,
          sender: isServer ? 'Host' : clientName,
          timestamp: new Date().toISOString()
        }));
        chatInput.value = '';
      } else {
        showToast('Cannot send message. Offline.', 'error');
      }
    });
  }

  // File & Folder input triggers
  fileInput.addEventListener('change', (e) => {
    handleSelectedFiles(e.target.files);
    fileInput.value = ''; // clear input
  });

  folderInput.addEventListener('change', (e) => {
    handleSelectedFiles(e.target.files);
    folderInput.value = ''; // clear input
  });

  // Drag and Drop listeners
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    
    const items = e.dataTransfer.items;
    if (items) {
      const filesToUpload = [];
      const promises = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i].webkitGetAsEntry();
        if (item) {
          promises.push(traverseFileTree(item).then(files => {
            filesToUpload.push(...files);
          }));
        }
      }

      await Promise.all(promises);
      if (filesToUpload.length > 0) {
        handleUploads(filesToUpload);
      }
    } else {
      handleSelectedFiles(e.dataTransfer.files);
    }
  });

  // Click on drop zone triggers file input
  dropZone.addEventListener('click', (e) => {
    // Prevent triggering input click twice if buttons inside are clicked
    if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'SPAN' && !e.target.closest('.btn')) {
      fileInput.click();
    }
  });
}

function showAuthError(message) {
  authError.innerText = message;
  authError.classList.remove('hidden');
}

// Traverse drag & drop items to parse folder trees recursively
async function traverseFileTree(entry, relPath = '') {
  const files = [];
  
  if (entry.isFile) {
    const file = await new Promise((resolve) => entry.file(resolve));
    // Override webkitRelativePath property with the custom path structured during traversal
    const customPath = relPath ? `${relPath}/${file.name}` : file.name;
    Object.defineProperty(file, 'webkitRelativePath', {
      value: customPath,
      writable: false,
      configurable: true
    });
    files.push(file);
  } else if (entry.isDirectory) {
    const dirReader = entry.createReader();
    const entries = await new Promise((resolve) => {
      const readAll = (acc = []) => {
        dirReader.readEntries((results) => {
          if (results.length === 0) {
            resolve(acc);
          } else {
            readAll(acc.concat(results));
          }
        }, () => resolve(acc)); // fallback on error
      };
      readAll();
    });

    for (const childEntry of entries) {
      const subPath = relPath ? `${relPath}/${entry.name}` : entry.name;
      const childFiles = await traverseFileTree(childEntry, subPath);
      files.push(...childFiles);
    }
  }
  
  return files;
}

// Handle inputs selection
function handleSelectedFiles(fileList) {
  if (fileList.length > 0) {
    handleUploads(Array.from(fileList));
  }
}

// Initialize the WebSocket and request dashboard data
function initializeDashboard() {
  connectWebSocket();
  fetchServerInfo();
  fetchFileList();
}

// Fetch Server Metadata (Server name, Port, LAN IPs, and PIN)
async function fetchServerInfo() {
  try {
    const response = await fetch(`/api/server-info?token=${token}`);
    if (response.ok) {
      const info = await response.json();
      
      // Update Server Status/Role state
      isServer = !!info.isServer;

      // Update header
      serverAddress.innerText = `http://${window.location.hostname}:${info.port}`;

      // Update PIN banner
      const pinText = document.getElementById('share-pin-text');
      if (pinText) pinText.innerText = info.pin;

      // Update LAN URLs container
      const linksContainer = document.getElementById('share-links-container');
      const shareBanner = document.getElementById('share-banner');

      if (isServer) {
        if (shareBanner) {
          shareBanner.style.display = 'flex';
        }
        if (linksContainer) {
          if (info.addresses && info.addresses.length > 0) {
            linksContainer.innerHTML = '';
            info.addresses.forEach(addr => {
              const pill = document.createElement('div');
              pill.className = 'share-link-pill';
              pill.title = 'Click to copy connection link';
              pill.innerHTML = `
                <i data-lucide="copy"></i>
                <span>${addr}</span>
                <button class="share-wa-pill-btn" title="Share link via WhatsApp">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397.01 12.008.01c3.202.001 6.212 1.246 8.477 3.513 2.262 2.268 3.507 5.28 3.505 8.484-.004 6.657-5.34 11.997-11.953 11.997-2.005-.001-3.973-.5-5.729-1.447L0 24zm6.59-4.846c1.6.95 3.188 1.449 4.825 1.451 5.436 0 9.86-4.42 9.864-9.852.002-2.632-1.023-5.105-2.887-6.97C16.581 1.968 14.1 .94 11.474.942c-5.436 0-9.86 4.42-9.864 9.852-.001 2.025.528 4.005 1.532 5.765l-.982 3.586 3.677-.964zm10.902-7.15c-.297-.15-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                  </svg>
                </button>
              `;
              
              // Copy on pill click
              pill.addEventListener('click', () => {
                navigator.clipboard.writeText(addr)
                  .then(() => showToast(`Connection link copied!`, 'success'))
                  .catch(() => showToast('Failed to copy link', 'error'));
              });

              // Share on WhatsApp click
              pill.querySelector('.share-wa-pill-btn').addEventListener('click', (event) => {
                event.stopPropagation(); // Avoid copy event trigger
                const shareText = `Connect to LocalDrop to transfer files:\n\n${addr}/\n\n🔐 PIN: ${info.pin}`;
                const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(shareText)}`;
                window.open(waUrl, '_blank');
              });

              linksContainer.appendChild(pill);
            });
            // Re-generate Lucide icons for added pills
            lucide.createIcons();
          } else {
            const fallbackLink = `http://${window.location.hostname}:${info.port}`;
            linksContainer.innerHTML = '';
            const pill = document.createElement('div');
            pill.className = 'share-link-pill';
            pill.title = 'Click to copy connection link';
            pill.innerHTML = `
              <i data-lucide="copy"></i>
              <span>${fallbackLink}</span>
              <button class="share-wa-pill-btn" title="Share link via WhatsApp">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397.01 12.008.01c3.202.001 6.212 1.246 8.477 3.513 2.262 2.268 3.507 5.28 3.505 8.484-.004 6.657-5.34 11.997-11.953 11.997-2.005-.001-3.973-.5-5.729-1.447L0 24zm6.59-4.846c1.6.95 3.188 1.449 4.825 1.451 5.436 0 9.86-4.42 9.864-9.852.002-2.632-1.023-5.105-2.887-6.97C16.581 1.968 14.1 .94 11.474.942c-5.436 0-9.86 4.42-9.864 9.852-.001 2.025.528 4.005 1.532 5.765l-.982 3.586 3.677-.964zm10.902-7.15c-.297-.15-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                </svg>
              </button>
            `;
            pill.addEventListener('click', () => {
              navigator.clipboard.writeText(fallbackLink)
                .then(() => showToast(`Connection link copied!`, 'success'))
                .catch(() => showToast('Failed to copy link', 'error'));
            });
            pill.querySelector('.share-wa-pill-btn').addEventListener('click', (event) => {
              event.stopPropagation();
              const shareText = `Connect to LocalDrop to transfer files:\n\n${fallbackLink}/\n\n🔐 PIN: ${info.pin}`;
              const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(shareText)}`;
              window.open(waUrl, '_blank');
            });
            linksContainer.appendChild(pill);
            lucide.createIcons();
          }
        }
      } else {
        if (shareBanner) {
          shareBanner.style.display = 'none';
        }
      }

      // Update connections header status text with correct context
      updateActiveConnections(lastConnectionCount);
    }
  } catch (err) {
    console.error('Failed to get server info:', err);
    serverAddress.innerText = `http://${window.location.host}`;
  }
}

// Fetch files from server
async function fetchFileList() {
  try {
    const response = await fetch(`/api/files?token=${token}`);
    if (response.ok) {
      const files = await response.json();
      renderFileList(files);
    } else if (response.status === 401) {
      clearSession();
    }
  } catch (err) {
    console.error('Failed to fetch files:', err);
  }
}

// Establish WebSockets
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}?token=${token}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    connectionStatus.innerText = 'Connected';
    connectionStatus.closest('.connection-pill').style.color = 'var(--accent-success)';
    connectionStatus.closest('.connection-pill').style.borderColor = 'rgba(16, 185, 129, 0.2)';
    connectionStatus.closest('.connection-pill').style.background = 'rgba(16, 185, 129, 0.1)';
    const pulseDot = connectionStatus.closest('.connection-pill').querySelector('.pulse-dot');
    if (pulseDot) pulseDot.style.backgroundColor = 'var(--accent-success)';
  };

  ws.onclose = () => {
    connectionStatus.innerText = 'Offline';
    connectionStatus.closest('.connection-pill').style.color = 'var(--accent-danger)';
    connectionStatus.closest('.connection-pill').style.borderColor = 'rgba(239, 68, 68, 0.2)';
    connectionStatus.closest('.connection-pill').style.background = 'rgba(239, 68, 68, 0.1)';
    const pulseDot = connectionStatus.closest('.connection-pill').querySelector('.pulse-dot');
    if (pulseDot) pulseDot.style.backgroundColor = 'var(--accent-danger)';
    
    // Auto-reconnect
    setTimeout(() => {
      if (token) connectWebSocket();
    }, reconnectInterval);
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'connections':
          connectedDevices = msg.devices || [];
          updateActiveConnections(msg.count);
          if (isServer && isModalOpen()) {
            renderDevicesModalContent();
          }
          break;
        case 'assigned_name':
          clientName = msg.name;
          break;
        case 'activity':
          if (isServer) {
            let toastType = 'info';
            let text = '';
            if (msg.data.type.endsWith('finished')) {
              toastType = 'success';
              text = `Activity Finished: ${msg.data.file}`;
            } else if (msg.data.type.endsWith('failed') || msg.data.type.endsWith('aborted')) {
              toastType = 'error';
              text = `Activity Stopped: ${msg.data.file}`;
            } else {
              text = `Activity Active: ${msg.data.file} (${msg.data.type.split('_')[1]})`;
            }
            showToast(text, toastType);
          }
          break;
        case 'chat_history':
          const chatMessages = document.getElementById('chat-messages');
          if (chatMessages) {
            chatMessages.innerHTML = '';
            (msg.data || []).forEach(appendChatMessage);
          }
          break;
        case 'chat':
          appendChatMessage(msg.data);
          break;
        case 'file_list':
          renderFileList(msg.data);
          break;
      }
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
    }
  };
}

function updateActiveConnections(count) {
  lastConnectionCount = count;
  const connStatusText = document.getElementById('connection-status');
  const connPill = connStatusText?.closest('.connection-pill');
  
  if (isServer) {
    connStatusText.innerText = `Connected (${count} client${count > 1 ? 's' : ''})`;
    if (connPill) {
      connPill.classList.add('interactive');
      connPill.title = 'Click to view connected devices';
    }
  } else {
    connStatusText.innerText = 'Connected';
    if (connPill) {
      connPill.classList.remove('interactive');
      connPill.removeAttribute('title');
    }
  }
}

// --- CONNECTED DEVICES MODAL (SERVER ONLY) ---

function parseUserAgent(ua) {
  let deviceType = 'laptop';
  let osName = 'Unknown OS';
  let browserName = 'Unknown Browser';

  if (ua.includes('Windows')) {
    osName = 'Windows';
    deviceType = 'laptop';
  } else if (ua.includes('Macintosh') || ua.includes('Mac OS X')) {
    osName = 'macOS';
    deviceType = 'laptop';
  } else if (ua.includes('Linux') && !ua.includes('Android')) {
    osName = 'Linux';
    deviceType = 'laptop';
  } else if (ua.includes('iPhone')) {
    osName = 'iPhone';
    deviceType = 'smartphone';
  } else if (ua.includes('iPad')) {
    osName = 'iPad';
    deviceType = 'tablet';
  } else if (ua.includes('Android')) {
    osName = 'Android';
    deviceType = 'smartphone';
  }

  if (ua.includes('Firefox')) {
    browserName = 'Firefox';
  } else if (ua.includes('Chrome') && !ua.includes('Edg') && !ua.includes('OPR')) {
    browserName = 'Chrome';
  } else if (ua.includes('Safari') && !ua.includes('Chrome')) {
    browserName = 'Safari';
  } else if (ua.includes('Edg')) {
    browserName = 'Edge';
  } else if (ua.includes('OPR') || ua.includes('Opera')) {
    browserName = 'Opera';
  }

  return {
    os: osName,
    browser: browserName,
    deviceType: deviceType,
    fullName: `${osName} (${browserName})`
  };
}

function openDevicesModal() {
  if (!isServer) return;
  
  let modal = document.getElementById('devices-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'devices-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="glass-card modal-card">
        <div class="modal-header">
          <div class="modal-header-title">
            <i data-lucide="smartphone"></i>
            <h3>Connected Devices</h3>
          </div>
          <button class="icon-btn close-modal-btn" id="close-devices-modal-btn" title="Close">
            <i data-lucide="x"></i>
          </button>
        </div>
        <div class="modal-body">
          <div class="devices-list" id="devices-modal-list">
            <!-- Dynamic list -->
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Bind close events
    const closeBtn = modal.querySelector('#close-devices-modal-btn');
    closeBtn.addEventListener('click', closeDevicesModal);
    
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeDevicesModal();
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', handleEscapeKey);
  }

  // Render content
  renderDevicesModalContent();

  // Show modal
  modal.style.display = 'flex';
  // Force reflow
  modal.offsetHeight;
  modal.classList.add('active');
}

function handleEscapeKey(e) {
  if (e.key === 'Escape') {
    closeDevicesModal();
  }
}

function closeDevicesModal() {
  const modal = document.getElementById('devices-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.addEventListener('transitionend', function handler() {
      modal.style.display = 'none';
      modal.removeEventListener('transitionend', handler);
    });
    document.removeEventListener('keydown', handleEscapeKey);
  }
}

function isModalOpen() {
  const modal = document.getElementById('devices-modal');
  return modal && modal.classList.contains('active');
}

function renderDevicesModalContent() {
  const listContainer = document.getElementById('devices-modal-list');
  if (!listContainer) return;

  if (connectedDevices.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        <i data-lucide="wifi-off"></i>
        <p>No connected devices</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  listContainer.innerHTML = '';
  connectedDevices.forEach((device) => {
    const parsed = parseUserAgent(device.userAgent);
    const row = document.createElement('div');
    row.className = 'device-row';
    
    const timeConnected = formatTimeAgo(new Date(device.connectedAt));
    const badgeText = device.isServer ? 'Host' : 'Client';
    const badgeClass = device.isServer ? 'device-badge host' : 'device-badge client';

    row.innerHTML = `
      <div class="device-info-left">
        <div class="device-icon-wrapper">
          <i data-lucide="${parsed.deviceType}"></i>
        </div>
        <div class="device-text-details">
          <span class="device-name" style="font-weight: 700;">${formatClientName(device.name) || parsed.fullName}</span>
          <span class="device-ip">${parsed.fullName} • ${device.ip}</span>
        </div>
      </div>
      <div class="device-info-right">
        <span class="${badgeClass}">${badgeText}</span>
        <span class="device-time" title="Connected at ${new Date(device.connectedAt).toLocaleTimeString()}">${timeConnected}</span>
      </div>
    `;
    listContainer.appendChild(row);
  });

  lucide.createIcons();
}

// Render dynamic shared files list
function renderFileList(files) {
  if (!files || files.length === 0) {
    emptyState.classList.remove('hidden');
    filesList.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  filesList.classList.remove('hidden');
  filesList.innerHTML = '';

  files.forEach((file) => {
    const row = document.createElement('div');
    row.className = 'file-row';

    const isFolder = file.type === 'directory';
    const iconName = isFolder ? 'folder' : 'file-text';
    const iconClass = isFolder ? 'file-icon directory' : 'file-icon file';

    row.innerHTML = `
      <div class="file-info">
        <div class="${iconClass}">
          <i data-lucide="${iconName}"></i>
        </div>
        <div class="file-text-details">
          <span class="file-name" title="${file.name}">${file.name}</span>
          <div class="file-meta">
            <span>${formatBytes(file.size)}</span>
            <span class="file-meta-sep"></span>
            <span>${formatTimeAgo(new Date(file.mtime))}</span>
          </div>
        </div>
      </div>
      <div class="file-actions">
        <button class="action-btn btn-download" title="Download ${isFolder ? 'Folder as ZIP' : 'File'}">
          <i data-lucide="download"></i>
        </button>
        <button class="action-btn btn-delete" title="Delete Shared Item">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    `;

    // Download binding
    row.querySelector('.btn-download').addEventListener('click', () => {
      downloadFileWithProgress(file);
    });

    // Delete binding
    row.querySelector('.btn-delete').addEventListener('click', async () => {
      if (confirm(`Are you sure you want to delete "${file.name}"?`)) {
        try {
          const response = await fetch(`/api/delete?path=${encodeURIComponent(file.path)}&token=${token}`, {
            method: 'DELETE'
          });
          if (response.ok) {
            showToast(`Deleted ${file.name}`, 'success');
          } else {
            const data = await response.json();
            showToast(data.error || 'Failed to delete file', 'error');
          }
        } catch (err) {
          showToast('Failed to delete file due to network error.', 'error');
        }
      }
    });

    filesList.appendChild(row);
  });

  // Re-generate Lucide icons for added elements
  lucide.createIcons();
}

// --- FILE UPLOAD LOGIC ---

// Queue the uploads
function handleUploads(files) {
  if (files.length === 0) return;
  
  if (uploadQueue.length === 0 && activeUploads.size === 0) {
    totalUploadBatchFiles = 0;
    completedUploadBatchFiles = 0;
  }
  totalUploadBatchFiles += files.length;

  files.forEach((file) => {
    const fileId = generateUUID();
    uploadQueue.push({ fileId, file });
  });

  transferCard.classList.remove('hidden');
  processUploadQueue();
}

// Concurrency queue processor
async function processUploadQueue() {
  if (activeUploadCount >= MAX_CONCURRENT_UPLOADS || uploadQueue.length === 0) {
    if (activeUploadCount === 0 && uploadQueue.length === 0) {
      // Completed all uploads!
      if (totalUploadBatchFiles > 0) {
        showToast(`Successfully uploaded all ${totalUploadBatchFiles} files!`, 'success');
      }
      setTimeout(() => {
        if (activeUploads.size === 0 && activeDownloads.size === 0) {
          transferCard.classList.add('hidden');
          transferQueue.innerHTML = '';
        }
      }, 3000);
    }
    return;
  }

  const { fileId, file } = uploadQueue.shift();
  activeUploadCount++;
  
  uploadFileInChunks(fileId, file).finally(() => {
    activeUploadCount--;
    processUploadQueue();
  });
}

// Perform chunked uploads
async function uploadFileInChunks(fileId, file) {
  const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunk sizes
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  const filename = file.webkitRelativePath || file.name;

  const uploadState = {
    name: filename,
    size: file.size,
    totalChunks,
    uploadedChunks: 0,
    startTime: Date.now(),
    bytesUploaded: 0,
    cancelled: false,
    error: false
  };

  activeUploads.set(fileId, uploadState);
  renderTransferQueue();

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    if (uploadState.cancelled) {
      activeUploads.delete(fileId);
      renderTransferQueue();
      return;
    }

    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const chunk = file.slice(start, end);

    let success = false;
    let retries = 3;

    while (!success && retries > 0 && !uploadState.cancelled) {
      try {
        const response = await fetch('/api/upload/chunk', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-File-Id': fileId,
            'X-File-Name': encodeURIComponent(filename),
            'X-Chunk-Index': chunkIndex.toString(),
            'X-Total-Chunks': totalChunks.toString(),
            'X-Chunk-Size': chunk.size.toString()
          },
          body: chunk
        });

        if (response.ok) {
          success = true;
          uploadState.uploadedChunks++;
          uploadState.bytesUploaded = end;
          updateTransferProgressUI(fileId);
        } else {
          retries--;
          if (retries === 0) throw new Error('Chunk response error status');
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        console.error(`Error uploading chunk ${chunkIndex} for file ${filename}:`, err);
        retries--;
        if (retries === 0) {
          uploadState.error = true;
          updateTransferProgressUI(fileId);
          showToast(`Failed to upload ${file.name}`, 'error');
          activeUploads.delete(fileId);
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  // Finalize UI
  activeUploads.delete(fileId);
  completedUploadBatchFiles++;
  renderTransferQueue();
}

// Render transfers active items lists
function renderTransferQueue() {
  transferCount.innerText = activeUploads.size + activeDownloads.size;
  
  if (activeUploads.size === 0 && activeDownloads.size === 0) {
    return;
  }

  // Build the list
  transferQueue.innerHTML = '';

  // Render batch summary progress
  if (totalUploadBatchFiles > 0) {
    const percent = Math.min(100, Math.round((completedUploadBatchFiles / totalUploadBatchFiles) * 100));
    const summaryItem = document.createElement('div');
    summaryItem.className = 'transfer-item batch-summary';
    summaryItem.style.borderLeft = '4px solid var(--accent-primary)';
    summaryItem.innerHTML = `
      <div class="transfer-info">
        <div class="transfer-name-area">
          <i data-lucide="folder-up"></i>
          <span class="transfer-name" style="font-weight: 700;">Uploading batch: ${completedUploadBatchFiles} of ${totalUploadBatchFiles} files completed</span>
        </div>
        <span class="transfer-speed">${percent}%</span>
      </div>
      <div class="progress-bar-container">
        <div class="progress-fill" style="width: ${percent}%"></div>
      </div>
    `;
    transferQueue.appendChild(summaryItem);
  }

  activeUploads.forEach((state, fileId) => {
    const item = document.createElement('div');
    item.className = 'transfer-item';
    item.id = `transfer-${fileId}`;

    const isFolder = state.name.includes('/');
    const iconName = isFolder ? 'folder' : 'file-text';

    item.innerHTML = `
      <div class="transfer-info">
        <div class="transfer-name-area">
          <i data-lucide="${iconName}"></i>
          <span class="transfer-name" title="${state.name}">${state.name}</span>
        </div>
        <span class="transfer-speed" id="speed-${fileId}">0 KB/s</span>
      </div>
      <div class="progress-bar-container">
        <div class="progress-fill" id="progress-${fileId}" style="width: 0%"></div>
      </div>
      <div class="transfer-meta">
        <span id="bytes-${fileId}">0 B / ${formatBytes(state.size)}</span>
        <span class="transfer-eta" id="eta-${fileId}">--:--</span>
      </div>
    `;
    transferQueue.appendChild(item);
  });

  activeDownloads.forEach((state, fileId) => {
    const item = document.createElement('div');
    item.className = 'transfer-item download-item';
    item.id = `transfer-${fileId}`;
    item.style.borderLeft = '4px solid var(--accent-secondary)';

    item.innerHTML = `
      <div class="transfer-info">
        <div class="transfer-name-area">
          <i data-lucide="download-cloud" style="color: var(--accent-secondary);"></i>
          <span class="transfer-name" title="${state.name}">${state.name}</span>
        </div>
        <span class="transfer-speed" id="speed-${fileId}">0 KB/s</span>
      </div>
      <div class="progress-bar-container">
        <div class="progress-fill" id="progress-${fileId}" style="width: 0%; background: linear-gradient(90deg, var(--accent-secondary), #3b82f6);"></div>
      </div>
      <div class="transfer-meta">
        <span id="bytes-${fileId}">0 B / ${state.size > 0 ? formatBytes(state.size) : 'Unknown'}</span>
        <span class="transfer-eta" id="eta-${fileId}">--:--</span>
      </div>
    `;
    transferQueue.appendChild(item);
  });
  
  lucide.createIcons();
}

// Update single item progress details in UI
function updateTransferProgressUI(fileId) {
  const state = activeUploads.get(fileId);
  if (!state) return;

  const percent = Math.min(100, Math.round((state.uploadedChunks / state.totalChunks) * 100));
  const progressFill = document.getElementById(`progress-${fileId}`);
  if (progressFill) progressFill.style.width = `${percent}%`;

  const bytesText = document.getElementById(`bytes-${fileId}`);
  if (bytesText) {
    bytesText.innerText = `${formatBytes(state.bytesUploaded)} / ${formatBytes(state.size)}`;
  }

  // Calculate Speed & ETA
  const elapsedMs = Date.now() - state.startTime;
  const speedBytesPerSec = state.bytesUploaded / (elapsedMs / 1000);
  
  const speedText = document.getElementById(`speed-${fileId}`);
  if (speedText) {
    speedText.innerText = `${formatBytes(speedBytesPerSec)}/s`;
  }

  const etaText = document.getElementById(`eta-${fileId}`);
  if (etaText && speedBytesPerSec > 0) {
    const remainingBytes = state.size - state.bytesUploaded;
    const remainingSeconds = Math.ceil(remainingBytes / speedBytesPerSec);
    
    if (remainingSeconds <= 0) {
      etaText.innerText = 'Finishing...';
    } else {
      etaText.innerText = formatTimeDuration(remainingSeconds);
    }
  }
}

// --- HELPER UTILITIES ---

function generateUUID() {
  if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'uploader-' + Math.random().toString(36).substring(2, 9) + '-' + Date.now();
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatTimeDuration(seconds) {
  if (seconds < 60) return `${seconds}s remaining`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s remaining`;
}

function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  let interval = Math.floor(seconds / 31536000);

  if (interval >= 1) return `${interval} year${interval > 1 ? 's' : ''} ago`;
  interval = Math.floor(seconds / 2592000);
  if (interval >= 1) return `${interval} month${interval > 1 ? 's' : ''} ago`;
  interval = Math.floor(seconds / 86400);
  if (interval >= 1) return `${interval} day${interval > 1 ? 's' : ''} ago`;
  interval = Math.floor(seconds / 3600);
  if (interval >= 1) return `${interval} hour${interval > 1 ? 's' : ''} ago`;
  interval = Math.floor(seconds / 60);
  if (interval >= 1) return `${interval} minute${interval > 1 ? 's' : ''} ago`;
  return 'just now';
}

function formatClientName(name) {
  if (!name) return 'Host';
  if (name.toLowerCase() === 'host') return 'Host';
  return name.split('_')
             .map(word => word.charAt(0).toUpperCase() + word.slice(1))
             .join(' ');
}

// Custom Toast Toast Notification Popup
function showToast(message, type = 'info') {
  // Remove existing toast if present
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let iconName = 'info';
  if (type === 'success') iconName = 'check-circle';
  if (type === 'error') iconName = 'alert-triangle';

  toast.innerHTML = `
    <i data-lucide="${iconName}"></i>
    <span>${message}</span>
  `;

  document.body.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s forwards ease-in';
    toast.addEventListener('animationend', () => toast.remove());
  }, 4000);
}

// Add CSS keyframes for slideOut dynamically if not present
if (!document.getElementById('toast-keyframes')) {
  const style = document.createElement('style');
  style.id = 'toast-keyframes';
  style.innerHTML = `
    @keyframes slideOut {
      from { transform: translateY(0) scale(1); opacity: 1; }
      to { transform: translateY(100px) scale(0.9); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

// --- STREAM DOWNLOADS & CHAT HELPERS ---

async function downloadFileWithProgress(file) {
  const fileId = generateUUID();
  const filename = file.name;
  const isFolder = file.type === 'directory';
  const displayFilename = isFolder ? `${filename}.zip` : filename;

  const downloadState = {
    name: displayFilename,
    size: file.size || 0,
    bytesDownloaded: 0,
    startTime: Date.now(),
    type: 'download',
    cancelled: false
  };

  activeDownloads.set(fileId, downloadState);
  transferCard.classList.remove('hidden');
  renderTransferQueue();

  try {
    const response = await fetch(`/api/download?path=${encodeURIComponent(file.path)}&token=${token}`);
    if (!response.ok) throw new Error('Download request failed');

    const reader = response.body.getReader();
    const contentLength = response.headers.get('Content-Length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : (file.size || 0);
    downloadState.size = totalBytes;

    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      downloadState.bytesDownloaded += value.length;
      updateDownloadProgressUI(fileId);
    }

    // Combine chunks into a single Blob and trigger browser save
    const blob = new Blob(chunks);
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = displayFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);

    showToast(`Successfully downloaded "${displayFilename}"`, 'success');
  } catch (err) {
    console.error('Download error:', err);
    showToast(`Failed to download "${displayFilename}"`, 'error');
  } finally {
    activeDownloads.delete(fileId);
    renderTransferQueue();
    if (activeUploads.size === 0 && activeDownloads.size === 0) {
      setTimeout(() => {
        if (activeUploads.size === 0 && activeDownloads.size === 0) {
          transferCard.classList.add('hidden');
          transferQueue.innerHTML = '';
        }
      }, 3000);
    }
  }
}

function updateDownloadProgressUI(fileId) {
  const state = activeDownloads.get(fileId);
  if (!state) return;

  const percent = state.size > 0 ? Math.min(100, Math.round((state.bytesDownloaded / state.size) * 100)) : 0;
  const progressFill = document.getElementById(`progress-${fileId}`);
  if (progressFill) progressFill.style.width = `${percent}%`;

  const bytesText = document.getElementById(`bytes-${fileId}`);
  if (bytesText) {
    if (state.size > 0) {
      bytesText.innerText = `${formatBytes(state.bytesDownloaded)} / ${formatBytes(state.size)}`;
    } else {
      bytesText.innerText = `${formatBytes(state.bytesDownloaded)} downloaded`;
    }
  }

  const elapsedMs = Date.now() - state.startTime;
  const speedBytesPerSec = state.bytesDownloaded / (elapsedMs / 1000);
  
  const speedText = document.getElementById('speed-' + fileId);
  if (speedText) {
    speedText.innerText = `${formatBytes(speedBytesPerSec)}/s`;
  }

  const etaText = document.getElementById('eta-' + fileId);
  if (etaText && speedBytesPerSec > 0 && state.size > 0) {
    const remainingBytes = state.size - state.bytesDownloaded;
    const remainingSeconds = Math.ceil(remainingBytes / speedBytesPerSec);
    
    if (remainingSeconds <= 0) {
      etaText.innerText = 'Saving...';
    } else {
      etaText.innerText = formatTimeDuration(remainingSeconds);
    }
  }
}

function getDeviceDisplayName() {
  const parsed = parseUserAgent(navigator.userAgent);
  return parsed.fullName;
}

function appendChatMessage(msg) {
  const chatMessages = document.getElementById('chat-messages');
  const chatEmpty = document.getElementById('chat-empty');
  if (chatEmpty) chatEmpty.remove();

  const msgContainer = document.createElement('div');
  
  const myName = isServer ? 'Host' : clientName;
  const isMe = msg.sender === myName;
  
  msgContainer.className = `chat-bubble-container ${isMe ? 'me' : 'others'}`;
  
  const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  let badgeText = 'Client';
  if (!msg.isServer) {
    badgeText = msg.deviceOS ? `Client (${msg.deviceOS})` : 'Client';
  } else {
    badgeText = 'Host';
  }
  
  const roleBadge = msg.isServer 
    ? '<span class="sender-role-badge host">Host</span>' 
    : `<span class="sender-role-badge client">${badgeText}</span>`;

  msgContainer.innerHTML = `
    <div class="chat-bubble-meta">
      <span class="sender-name">${formatClientName(msg.sender)}</span>
      ${roleBadge}
      ${timeStr ? `<span class="sender-time">${timeStr}</span>` : ''}
    </div>
    <div class="chat-bubble">
      ${escapeHtml(msg.text)}
    </div>
  `;

  chatMessages.appendChild(msgContainer);
  chatMessages.scrollTop = chatMessages.scrollHeight; // auto-scroll
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
