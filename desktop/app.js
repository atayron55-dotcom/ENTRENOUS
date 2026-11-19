'use strict';

const $ = (id) => document.getElementById(id);
const SIGNAL_DEFAULT_STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DB_NAME = 'entre-nous-p2p';
const DB_VERSION = 1;

let db;
let settings = { signalUrl: '' };
let localProfile;
let remoteProfile = { id: 'remote', name: 'Ta moitié', avatar: null };
let customEmojis = [];
let emojiByName = new Map();
let rtc = null;
let dataChannel = null;
let signalSocket = null;
let sessionRole = null;
let sessionRoom = null;
let sessionSecret = null;
let encryptionKey = null;
let pendingCandidates = [];
let incomingFiles = new Map();
let sessionConnected = false;
let pendingImage = null;
let toastTimer;
const objectUrlCache = new WeakMap();

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('profiles')) database.createObjectStore('profiles', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('messages')) {
        const store = database.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!database.objectStoreNames.contains('emojis')) database.createObjectStore('emojis', { keyPath: 'name' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storeRequest(storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let request;
    try { request = operation(store); }
    catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error || request?.error);
    tx.onabort = () => reject(tx.error || new Error('Opération locale annulée.'));
  });
}
const getRecord = (store, key) => storeRequest(store, 'readonly', (s) => s.get(key));
const putRecord = (store, value) => storeRequest(store, 'readwrite', (s) => s.put(value));
const removeRecord = (store, key) => storeRequest(store, 'readwrite', (s) => s.delete(key));
const getAllRecords = (store) => storeRequest(store, 'readonly', (s) => s.getAll());

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${randomChars(12)}`;
}
function randomChars(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
function formatInvite(room, secret) {
  const raw = `${room}${secret}`;
  return raw.match(/.{1,4}/g).join('-');
}
function parseInvite(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 34 || [...raw].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return { room: raw.slice(0, 10), secret: raw.slice(10) };
}
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function setLobbyStatus(message, isError = false) {
  $('lobbyStatus').textContent = message;
  $('lobbyStatus').classList.toggle('error', isError);
}
function setConnectionState(connected, label) {
  $('connectionDot').parentElement.classList.toggle('connected', connected);
  $('connectionLabel').textContent = label;
  $('partnerDot').classList.toggle('online', connected);
  $('partnerStatus').textContent = connected ? 'En ligne · connexion directe' : 'Pas encore connecté·e';
}
function showView(view) {
  $('lobbyView').hidden = view !== 'lobby';
  $('waitingView').hidden = view !== 'waiting';
  $('chatView').hidden = view !== 'chat';
}
function blobUrl(blob) {
  if (!blob) return '';
  const cached = objectUrlCache.get(blob);
  if (cached) return cached;
  const url = URL.createObjectURL(blob);
  objectUrlCache.set(blob, url);
  return url;
}
function setAvatar(element, blob, fallback = '♡') {
  element.replaceChildren();
  if (blob instanceof Blob) {
    const image = document.createElement('img');
    image.src = blobUrl(blob);
    image.alt = '';
    element.append(image);
  } else {
    element.textContent = fallback;
  }
}
function updateProfileUI() {
  $('localName').textContent = localProfile.name || 'Moi';
  $('displayName').value = localProfile.name || '';
  setAvatar($('localAvatar'), localProfile.avatar);
  setAvatar($('settingsAvatar'), localProfile.avatar);
  $('partnerName').textContent = remoteProfile.name || 'Ta moitié';
  $('chatPartnerName').textContent = remoteProfile.name || 'Notre conversation';
  setAvatar($('partnerAvatar'), remoteProfile.avatar);
  setAvatar($('chatPartnerAvatar'), remoteProfile.avatar);
}

function showSettings() {
  $('signalUrl').value = settings.signalUrl || '';
  $('turnUrl').value = settings.turnUrl || '';
  $('turnUsername').value = settings.turnUsername || '';
  $('turnCredential').value = settings.turnCredential || '';
  $('settingsModal').hidden = false;
}
function closeSettings() { $('settingsModal').hidden = true; }

async function deriveSessionKey(secret, room) {
  if (!crypto.subtle) throw new Error('Le chiffrement du navigateur intégré est indisponible. Mets à jour l’application.');
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode(`EntreNous:${room}:v2`), iterations: 180000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function deriveInviteProof(secret, room) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`EntreNous:${room}:join:v1`)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function encryptPacket(packet) {
  if (!encryptionKey) throw new Error('Clé de session indisponible.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const clear = new TextEncoder().encode(JSON.stringify(packet));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, clear));
  const result = new Uint8Array(iv.length + encrypted.length);
  result.set(iv, 0);
  result.set(encrypted, iv.length);
  return result.buffer;
}
async function decryptPacket(buffer) {
  if (!encryptionKey) return null;
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 29) return null;
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, encryptionKey, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(clear));
}

async function sendPacket(packet) {
  if (!dataChannel || dataChannel.readyState !== 'open') throw new Error('La connexion avec ta moitié est interrompue.');
  while (dataChannel.bufferedAmount > 512 * 1024 && dataChannel.readyState === 'open') {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  if (dataChannel.readyState !== 'open') throw new Error('La connexion a été interrompue.');
  dataChannel.send(await encryptPacket(packet));
}

function connectSignal(mode, room, proof) {
  return new Promise((resolve, reject) => {
    if (!settings.signalUrl) {
      showSettings();
      reject(new Error('Configure d’abord le service de mise en relation dans les paramètres.'));
      return;
    }
    let url;
    try { url = new URL(settings.signalUrl); }
    catch { reject(new Error('Adresse du service de mise en relation invalide.')); return; }
    if (!['wss:', 'ws:'].includes(url.protocol)) {
      reject(new Error('Adresse invalide : utilise wss://.'));
      return;
    }
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { signalSocket?.close(); } catch { /* ignore */ }
        reject(new Error('Le service de mise en relation ne répond pas.'));
      }
    }, 12000);

    url.searchParams.set('room', room);
    signalSocket = new WebSocket(url.toString());
    let keepAlive = null;
    signalSocket.addEventListener('open', () => {
      signalSocket.send(JSON.stringify({ type: mode, room, proof }));
      keepAlive = setInterval(() => {
        if (signalSocket?.readyState === WebSocket.OPEN) signalSocket.send('{"type":"ping"}');
      }, 25000);
    });
    signalSocket.addEventListener('message', async (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'created' || message.type === 'joined') {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(true);
        }
        if (message.type === 'joined') setLobbyStatus('Code accepté. Négociation de la connexion…');
        return;
      }
      if (message.type === 'peer-joined') {
        if (sessionRole === 'host') await startPeerConnection(true);
        return;
      }
      if (message.type === 'signal') {
        await handleSignaling(message.data);
        return;
      }
      if (message.type === 'peer-left') {
        handlePeerLeft();
        return;
      }
      if (message.type === 'error') {
        const error = new Error(message.message || 'Le service a refusé la session.');
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        } else {
          toast(error.message);
          endSession(false);
        }
      }
    });
    signalSocket.addEventListener('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Impossible de joindre le service. Vérifie son adresse et ta connexion.'));
      }
    });
    signalSocket.addEventListener('close', () => {
      clearInterval(keepAlive);
      if (sessionRole) handlePeerLeft();
    });
  });
}

function sendSignal(data) {
  if (signalSocket?.readyState === WebSocket.OPEN) {
    signalSocket.send(JSON.stringify({ type: 'signal', data }));
  }
}

async function createSession() {
  try {
    $('createSession').disabled = true;
    setLobbyStatus('Création de la session…');
    sessionRole = 'host';
    sessionRoom = randomChars(10);
    sessionSecret = randomChars(24);
    encryptionKey = await deriveSessionKey(sessionSecret, sessionRoom);
    const proof = await deriveInviteProof(sessionSecret, sessionRoom);
    await connectSignal('create', sessionRoom, proof);
    $('inviteCodeDisplay').textContent = formatInvite(sessionRoom, sessionSecret);
    $('waitingStatus').textContent = 'En attente de la deuxième personne…';
    showView('waiting');
    setConnectionState(false, 'En attente');
  } catch (error) {
    sessionRole = null;
    sessionRoom = null;
    sessionSecret = null;
    encryptionKey = null;
    setLobbyStatus(error.message, true);
    showView('lobby');
  } finally {
    $('createSession').disabled = false;
  }
}

async function joinSession() {
  const invite = parseInvite($('inviteCode').value);
  if (!invite) {
    setLobbyStatus('Ce code est invalide. Il doit contenir 34 caractères (sans les tirets).', true);
    return;
  }
  try {
    $('joinSession').disabled = true;
    setLobbyStatus('Connexion au service…');
    sessionRole = 'guest';
    sessionRoom = invite.room;
    sessionSecret = invite.secret;
    encryptionKey = await deriveSessionKey(sessionSecret, sessionRoom);
    const proof = await deriveInviteProof(sessionSecret, sessionRoom);
    await connectSignal('join', sessionRoom, proof);
    showView('waiting');
    $('inviteCodeDisplay').textContent = 'Session rejointe';
    $('waitingStatus').textContent = 'Négociation de la connexion…';
  } catch (error) {
    sessionRole = null;
    sessionRoom = null;
    sessionSecret = null;
    encryptionKey = null;
    setLobbyStatus(error.message, true);
    showView('lobby');
  } finally {
    $('joinSession').disabled = false;
  }
}

async function startPeerConnection(isHost) {
  if (rtc) return;
  try {
    const iceServers = [...SIGNAL_DEFAULT_STUN];
    if (settings.turnUrl) {
      iceServers.push({ urls: settings.turnUrl, username: settings.turnUsername || '', credential: settings.turnCredential || '' });
    }
    rtc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    rtc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ kind: 'ice', candidate: event.candidate });
    };
    rtc.onconnectionstatechange = () => {
      if (rtc?.connectionState === 'failed' || rtc?.connectionState === 'disconnected' || rtc?.connectionState === 'closed') {
        if (sessionConnected) handlePeerLeft();
      }
    };
    if (isHost) {
      dataChannel = rtc.createDataChannel('entre-nous', { ordered: true });
      attachDataChannel(dataChannel);
      const offer = await rtc.createOffer();
      await rtc.setLocalDescription(offer);
      sendSignal({ kind: 'description', description: rtc.localDescription });
      $('waitingStatus').textContent = 'Connexion directe en cours…';
    } else {
      rtc.ondatachannel = (event) => {
        dataChannel = event.channel;
        attachDataChannel(dataChannel);
      };
    }
  } catch (error) {
    toast(`Connexion impossible : ${error.message}`);
    endSession(false);
  }
}

async function handleSignaling(data) {
  if (!data || !data.kind) return;
  if (!rtc) await startPeerConnection(sessionRole === 'host');
  if (!rtc) return;
  try {
    if (data.kind === 'description' && data.description) {
      await rtc.setRemoteDescription(data.description);
      for (const candidate of pendingCandidates.splice(0)) {
        try { await rtc.addIceCandidate(candidate); } catch { /* stale ICE */ }
      }
      if (data.description.type === 'offer') {
        const answer = await rtc.createAnswer();
        await rtc.setLocalDescription(answer);
        sendSignal({ kind: 'description', description: rtc.localDescription });
      }
    } else if (data.kind === 'ice' && data.candidate) {
      if (rtc.remoteDescription) await rtc.addIceCandidate(data.candidate);
      else pendingCandidates.push(data.candidate);
    }
  } catch (error) {
    console.warn('Signal WebRTC ignoré :', error.message);
  }
}

function attachDataChannel(channel) {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 128 * 1024;
  channel.onopen = async () => {
    setConnectionState(false, 'Vérification du code…');
    $('waitingStatus').textContent = 'Vérification chiffrée de la session…';
    try {
      // Le secret de l’invitation n’est jamais envoyé au service de mise en relation.
      // Seul un pair connaissant ce secret peut produire un hello déchiffrable.
      await sendPacket({ type: 'hello', profile: { id: localProfile.id, name: localProfile.name } });
    } catch (error) { toast(error.message); }
    setTimeout(() => {
      if (!sessionConnected && dataChannel?.readyState === 'open') {
        toast('Code de session non vérifié. Vérifie que tu as partagé le bon code.');
        endSession(true);
      }
    }, 15000);
  };
  channel.onmessage = async (event) => {
    try {
      const packet = await decryptPacket(event.data);
      if (packet) await handlePacket(packet);
    } catch (error) {
      // Un paquet qui ne possède pas la clé de cette invitation est ignoré.
      console.warn('Paquet chiffré ignoré.');
    }
  };
  channel.onclose = () => handlePeerLeft();
  channel.onerror = () => toast('Une erreur est survenue sur la connexion directe.');
}

async function handlePacket(packet) {
  switch (packet.type) {
    case 'hello': {
      const firstVerifiedPacket = !sessionConnected;
      remoteProfile.name = String(packet.profile?.name || 'Ta moitié').slice(0, 32);
      remoteProfile.id = String(packet.profile?.id || 'remote');
      await putRecord('profiles', { id: 'remote', name: remoteProfile.name, remoteId: remoteProfile.id, avatar: remoteProfile.avatar || null });
      updateProfileUI();
      if (firstVerifiedPacket) {
        sessionConnected = true;
        showView('chat');
        setConnectionState(true, 'Connecté');
        $('waitingStatus').textContent = 'Connexion établie.';
        if (localProfile.avatar) await sendFile(localProfile.avatar, 'avatar', 'remote-profile', 'avatar.png');
        await syncEmojis();
        await syncHistoryList();
        renderMessages();
      }
      break;
    }
    case 'message':
    case 'sync-message': {
      const existing = await getRecord('messages', packet.message.id);
      const merged = existing ? { ...packet.message, image: existing.image || null } : packet.message;
      await putRecord('messages', merged);
      renderMessages();
      break;
    }
    case 'sync-list': {
      const local = await getAllRecords('messages');
      const localMap = new Map(local.map((m) => [m.id, m]));
      const missing = [];
      for (const item of (packet.items || []).slice(-400)) {
        const ours = localMap.get(item.id);
        if (!ours || (item.hasImage && !ours.image)) missing.push(item.id);
      }
      if (missing.length) await sendPacket({ type: 'sync-need', ids: missing });
      break;
    }
    case 'sync-need': {
      for (const id of (packet.ids || []).slice(0, 400)) {
        const message = await getRecord('messages', id);
        if (!message) continue;
        const { image, ...metadata } = message;
        metadata.hasImage = !!image || !!message.hasImage;
        await sendPacket({ type: 'sync-message', message: metadata });
        if (image) await sendFile(image, 'message-image', id, 'image');
      }
      break;
    }
    case 'file-start':
      if (typeof packet.id !== 'string' || !Number.isInteger(packet.totalChunks) || packet.totalChunks < 1 || packet.totalChunks > 300 || !Number.isInteger(packet.size) || packet.size < 1 || packet.size > 5 * 1024 * 1024) break;
      incomingFiles.set(packet.id, { ...packet, chunks: new Array(packet.totalChunks), received: 0 });
      break;
    case 'file-chunk': {
      const transfer = incomingFiles.get(packet.id);
      if (!transfer || packet.index < 0 || packet.index >= transfer.totalChunks) break;
      transfer.chunks[packet.index] = base64ToBytes(packet.data);
      transfer.received += 1;
      break;
    }
    case 'file-end':
      await finishIncomingFile(packet.id);
      break;
    case 'emoji-removed':
      await removeRecord('emojis', packet.name);
      await loadEmojis();
      break;
    case 'typing':
      // Réservé pour un futur indicateur de saisie.
      break;
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sendFile(blob, purpose, referenceId, filename, extra = {}) {
  if (!(blob instanceof Blob)) return;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 18 * 1024;
  const totalChunks = Math.ceil(bytes.length / chunkSize);
  const transferId = uid();
  await sendPacket({ type: 'file-start', id: transferId, purpose, referenceId, filename, mime: blob.type || 'application/octet-stream', totalChunks, size: bytes.length, extra });
  for (let index = 0; index < totalChunks; index++) {
    const chunk = bytes.subarray(index * chunkSize, Math.min(bytes.length, (index + 1) * chunkSize));
    await sendPacket({ type: 'file-chunk', id: transferId, index, data: bytesToBase64(chunk) });
  }
  await sendPacket({ type: 'file-end', id: transferId });
}

async function finishIncomingFile(transferId) {
  const transfer = incomingFiles.get(transferId);
  if (!transfer) return;
  incomingFiles.delete(transferId);
  if (transfer.received !== transfer.totalChunks || transfer.chunks.some((chunk) => !chunk)) {
    toast('Un fichier reçu est incomplet.');
    return;
  }
  const blob = new Blob(transfer.chunks, { type: transfer.mime });
  if (transfer.size !== blob.size) return;
  if (transfer.purpose === 'message-image') {
    const message = await getRecord('messages', transfer.referenceId);
    if (message) {
      message.image = blob;
      await putRecord('messages', message);
      renderMessages();
    }
  } else if (transfer.purpose === 'avatar') {
    remoteProfile.avatar = blob;
    await putRecord('profiles', { id: 'remote', name: remoteProfile.name, remoteId: remoteProfile.id, avatar: blob });
    updateProfileUI();
  } else if (transfer.purpose === 'emoji') {
    const name = String(transfer.extra?.emojiName || transfer.referenceId).toLowerCase();
    if (/^[a-z0-9_-]{1,24}$/.test(name)) {
      await putRecord('emojis', { name, blob, createdAt: Date.now(), owner: 'peer' });
      await loadEmojis();
    }
  }
}

async function syncEmojis() {
  const emojis = await getAllRecords('emojis');
  for (const emoji of emojis) {
    await sendFile(emoji.blob, 'emoji', emoji.name, `${emoji.name}.png`, { emojiName: emoji.name });
  }
}
async function syncHistoryList() {
  const messages = (await getAllRecords('messages')).sort((a, b) => a.createdAt - b.createdAt).slice(-400);
  await sendPacket({
    type: 'sync-list',
    items: messages.map((m) => ({ id: m.id, hasImage: !!m.image || !!m.hasImage }))
  });
}

function handlePeerLeft() {
  if (!sessionRole) return;
  sessionConnected = false;
  try { rtc?.close(); } catch { /* ignore */ }
  rtc = null;
  dataChannel = null;
  incomingFiles.clear();
  setConnectionState(false, 'Déconnecté');
  showView('lobby');
  setLobbyStatus('La connexion a été interrompue. Crée une nouvelle session pour vous retrouver.');
  closeSignalSocket();
  sessionRole = null;
  sessionRoom = null;
  sessionSecret = null;
  encryptionKey = null;
}
function closeSignalSocket() {
  if (signalSocket) {
    const old = signalSocket;
    signalSocket = null;
    try { old.close(); } catch { /* ignore */ }
  }
}
function endSession(showLobby = true) {
  sessionConnected = false;
  try { rtc?.close(); } catch { /* ignore */ }
  rtc = null;
  dataChannel = null;
  closeSignalSocket();
  sessionRole = null;
  sessionRoom = null;
  sessionSecret = null;
  encryptionKey = null;
  pendingCandidates = [];
  incomingFiles.clear();
  setConnectionState(false, 'Hors session');
  if (showLobby) showView('lobby');
}

async function addTextMessage() {
  const text = $('messageInput').value.trim();
  if (!text && !pendingImage) return;
  if (!sessionConnected) { toast('Connecte-toi à ta moitié avant d’envoyer un message.'); return; }
  const message = {
    id: uid(),
    senderId: localProfile.id,
    senderName: localProfile.name,
    text,
    createdAt: Date.now(),
    image: pendingImage || null
  };
  await putRecord('messages', message);
  $('messageInput').value = '';
  $('messageInput').style.height = 'auto';
  const imageToSend = pendingImage;
  pendingImage = null;
  $('attachmentPreview').hidden = true;
  renderMessages();
  try {
    const { image, ...metadata } = message;
    await sendPacket({ type: 'message', message: { ...metadata, hasImage: !!image } });
    if (imageToSend) await sendFile(imageToSend, 'message-image', message.id, 'image');
  } catch (error) {
    toast(error.message);
  }
}

async function renderMessages() {
  if (!db) return;
  const messages = (await getAllRecords('messages')).sort((a, b) => a.createdAt - b.createdAt);
  const container = $('messages');
  container.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-chat';
    const heart = document.createElement('div'); heart.textContent = '♡';
    const heading = document.createElement('h3'); heading.textContent = 'Vous voilà réunis.';
    const note = document.createElement('p'); note.textContent = 'Votre conversation commence ici.';
    empty.append(heart, heading, note); container.append(empty); return;
  }
  for (const message of messages.slice(-1000)) {
    const mine = message.senderId === localProfile.id;
    const row = document.createElement('div');
    row.className = `message-row${mine ? ' mine' : ''}`;
    const avatar = document.createElement('div'); avatar.className = 'message-avatar';
    const avatarBlob = mine ? localProfile.avatar : remoteProfile.avatar;
    if (avatarBlob) { const img = document.createElement('img'); img.src = blobUrl(avatarBlob); avatar.append(img); }
    else avatar.textContent = '♡';
    const wrap = document.createElement('div'); wrap.className = 'bubble-wrap';
    const meta = document.createElement('div'); meta.className = 'message-meta';
    meta.textContent = `${mine ? 'Toi' : (message.senderName || remoteProfile.name)} · ${new Date(message.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`;
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    appendEmojiText(bubble, message.text || '');
    if (message.image instanceof Blob) {
      const img = document.createElement('img'); img.className = 'attached-image'; img.src = blobUrl(message.image); img.alt = 'Image partagée';
      img.addEventListener('click', () => openImagePreview(img.src));
      bubble.append(img);
    }
    wrap.append(meta, bubble); row.append(avatar, wrap); container.append(row);
  }
  container.scrollTop = container.scrollHeight;
}

function appendEmojiText(container, value) {
  const regex = /:([a-z0-9_-]{1,24}):/gi;
  let last = 0;
  let match;
  while ((match = regex.exec(value)) !== null) {
    if (match.index > last) appendTextWithBreaks(container, value.slice(last, match.index));
    const emoji = emojiByName.get(match[1].toLowerCase());
    if (emoji) {
      const img = document.createElement('img'); img.className = 'inline-emoji'; img.src = blobUrl(emoji.blob); img.alt = `:${emoji.name}:`; img.title = `:${emoji.name}:`; container.append(img);
    } else appendTextWithBreaks(container, match[0]);
    last = regex.lastIndex;
  }
  if (last < value.length) appendTextWithBreaks(container, value.slice(last));
}
function appendTextWithBreaks(container, text) {
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (index) container.append(document.createElement('br'));
    container.append(document.createTextNode(line));
  });
}
function openImagePreview(src) {
  // Aperçu dans une surcouche locale, sans navigation distante.
  const overlay = document.createElement('div');
  overlay.className = 'image-preview-overlay';
  const img = document.createElement('img'); img.src = src; img.alt = 'Aperçu de la photo';
  overlay.append(img); overlay.addEventListener('click', () => overlay.remove()); document.body.append(overlay);
}

async function loadEmojis() {
  customEmojis = await getAllRecords('emojis');
  emojiByName = new Map(customEmojis.map((item) => [item.name, item]));
  renderEmojiPicker();
  renderCustomEmojiSettings();
}
function renderEmojiPicker() {
  const grid = $('emojiGrid'); grid.replaceChildren();
  const defaults = ['❤️', '💕', '💗', '🥰', '😘', '😍', '🫶', '💋', '🌹', '✨', '🥺', '😊', '😂', '😭', '🤍', '🖤', '🌙', '⭐'];
  for (const symbol of defaults) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = symbol;
    button.addEventListener('click', () => insertText(symbol)); grid.append(button);
  }
  for (const emoji of customEmojis) {
    const button = document.createElement('button'); button.type = 'button'; button.title = `:${emoji.name}:`;
    const img = document.createElement('img'); img.src = blobUrl(emoji.blob); img.alt = emoji.name;
    button.append(img); button.addEventListener('click', () => insertText(`:${emoji.name}:`)); grid.append(button);
  }
}
function renderCustomEmojiSettings() {
  const list = $('customEmojiList'); list.replaceChildren();
  for (const emoji of customEmojis) {
    const item = document.createElement('div'); item.className = 'custom-emoji-item';
    const img = document.createElement('img'); img.src = blobUrl(emoji.blob); img.alt = '';
    const name = document.createElement('span'); name.textContent = `:${emoji.name}:`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = 'Supprimer cet emoji';
    remove.addEventListener('click', async () => {
      await removeRecord('emojis', emoji.name); await loadEmojis();
      if (sessionConnected) await sendPacket({ type: 'emoji-removed', name: emoji.name });
    });
    item.append(img, name, remove); list.append(item);
  }
}
function insertText(value) {
  const input = $('messageInput');
  const start = input.selectionStart; const end = input.selectionEnd;
  input.setRangeText(value, start, end, 'end'); input.focus();
  $('emojiPicker').hidden = true;
}

async function compressImage(file, maxEdge = 1600, maxBytes = 5 * 1024 * 1024) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choisis une image PNG, JPEG ou WebP.');
  if (file.size > maxBytes) throw new Error('Cette image dépasse la limite de 5 Mo.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.88));
  if (!blob) throw new Error('Impossible de préparer cette image.');
  return blob;
}

async function saveLocalProfile() {
  localProfile.name = $('displayName').value.trim().slice(0, 32) || 'Moi';
  await putRecord('profiles', localProfile);
  updateProfileUI();
  $('profileFeedback').textContent = 'Profil enregistré sur cet ordinateur.';
  if (sessionConnected) {
    try {
      await sendPacket({ type: 'hello', profile: { id: localProfile.id, name: localProfile.name } });
      if (localProfile.avatar) await sendFile(localProfile.avatar, 'avatar', 'remote-profile', 'avatar.png');
    } catch (error) { toast(error.message); }
  }
}

async function saveAvatar(file) {
  try {
    localProfile.avatar = await compressImage(file, 512, 5 * 1024 * 1024);
    await putRecord('profiles', localProfile);
    updateProfileUI();
    $('profileFeedback').textContent = 'Photo enregistrée.';
    if (sessionConnected) await sendFile(localProfile.avatar, 'avatar', 'remote-profile', 'avatar.png');
  } catch (error) { $('profileFeedback').textContent = error.message; }
}

async function addCustomEmoji() {
  const name = $('emojiName').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 24);
  const file = $('emojiInput').files?.[0];
  if (!/^[a-z0-9_-]{1,24}$/.test(name)) { $('emojiFeedback').textContent = 'Choisis un nom composé de lettres, chiffres ou tirets.'; return; }
  if (!file) { $('emojiFeedback').textContent = 'Choisis d’abord une image.'; return; }
  try {
    const blob = await compressImage(file, 160, 2 * 1024 * 1024);
    await putRecord('emojis', { name, blob, createdAt: Date.now(), owner: 'local' });
    await loadEmojis();
    $('emojiName').value = ''; $('emojiInput').value = '';
    $('emojiFeedback').textContent = 'Emoji ajouté.';
    if (sessionConnected) await sendFile(blob, 'emoji', name, `${name}.png`, { emojiName: name });
  } catch (error) { $('emojiFeedback').textContent = error.message; }
}

async function saveSignalSettings() {
  try {
    settings = await window.entreNousDesktop.saveSettings({
      signalUrl: $('signalUrl').value.trim(),
      turnUrl: $('turnUrl').value.trim(),
      turnUsername: $('turnUsername').value.trim(),
      turnCredential: $('turnCredential').value
    });
    $('signalFeedback').textContent = 'Adresse enregistrée.';
    $('signalFeedback').classList.remove('error');
    $('signalFeedback').classList.add('good');
  } catch (error) {
    $('signalFeedback').textContent = error.message;
    $('signalFeedback').classList.remove('good');
    $('signalFeedback').classList.add('error');
  }
}

async function copyInvite() {
  const text = $('inviteCodeDisplay').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('Code copié !');
  } catch {
    const helper = document.createElement('textarea'); helper.value = text; document.body.append(helper); helper.select();
    document.execCommand('copy'); helper.remove(); toast('Code copié !');
  }
}

function bindEvents() {
  $('settingsButton').addEventListener('click', showSettings);
  $('topSettings').addEventListener('click', showSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('settingsModal').addEventListener('click', (event) => { if (event.target === $('settingsModal')) closeSettings(); });
  $('createSession').addEventListener('click', createSession);
  $('joinSession').addEventListener('click', joinSession);
  $('inviteCode').addEventListener('keydown', (event) => { if (event.key === 'Enter') joinSession(); });
  $('copyInvite').addEventListener('click', copyInvite);
  $('cancelWaiting').addEventListener('click', () => endSession(true));
  $('newSessionSide').addEventListener('click', () => { endSession(true); setLobbyStatus('Prêt à créer une nouvelle session.'); });
  $('saveSignal').addEventListener('click', saveSignalSettings);
  $('saveProfile').addEventListener('click', saveLocalProfile);
  $('avatarInput').addEventListener('change', (event) => { if (event.target.files?.[0]) saveAvatar(event.target.files[0]); });
  $('addEmoji').addEventListener('click', addCustomEmoji);
  $('attachButton').addEventListener('click', () => $('imageInput').click());
  $('imageInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      pendingImage = await compressImage(file, 1600, 5 * 1024 * 1024);
      $('attachmentName').textContent = file.name;
      $('attachmentPreview').hidden = false;
    } catch (error) { toast(error.message); }
    event.target.value = '';
  });
  $('removeAttachment').addEventListener('click', () => { pendingImage = null; $('attachmentPreview').hidden = true; });
  $('sendButton').addEventListener('click', addTextMessage);
  $('messageInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); addTextMessage(); }
  });
  $('messageInput').addEventListener('input', () => {
    const input = $('messageInput'); input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
  });
  $('emojiButton').addEventListener('click', () => { $('emojiPicker').hidden = !$('emojiPicker').hidden; });
  $('closeEmoji').addEventListener('click', () => { $('emojiPicker').hidden = true; });
  $('addEmojiFromPicker').addEventListener('click', () => { $('emojiPicker').hidden = true; showSettings(); });
  window.entreNousDesktop.onOpenSettings(showSettings);
  window.addEventListener('beforeunload', () => { try { rtc?.close(); signalSocket?.close(); } catch { /* ignore */ } });
}

async function initialise() {
  db = await openDatabase();
  settings = await window.entreNousDesktop.getSettings();
  localProfile = await getRecord('profiles', 'local');
  if (!localProfile) {
    localProfile = { id: uid(), name: 'Moi', avatar: null, createdAt: Date.now() };
    await putRecord('profiles', localProfile);
  }
  const savedRemote = await getRecord('profiles', 'remote');
  if (savedRemote) remoteProfile = { ...remoteProfile, ...savedRemote };
  await loadEmojis();
  updateProfileUI();
  bindEvents();
  setConnectionState(false, 'Hors session');
  showView('lobby');
  if (!settings.signalUrl) setLobbyStatus('Bienvenue ! Ouvre les paramètres pour configurer le service de mise en relation.');
  else setLobbyStatus('Prêt. Crée une session ou rejoins un code d’invitation.');
}

initialise().catch((error) => {
  console.error(error);
  const main = document.createElement('main');
  main.className = 'startup-error';
  const title = document.createElement('h1'); title.textContent = 'Entre Nous n’a pas pu démarrer';
  const detail = document.createElement('p'); detail.textContent = String(error.message || error);
  const advice = document.createElement('p'); advice.textContent = 'Redémarre l’application. Si le problème persiste, contacte la personne qui t’a fourni le programme.';
  main.append(title, detail, advice);
  document.body.replaceChildren(main);
});
