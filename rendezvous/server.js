'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 8765);
const PATH = process.env.WS_PATH || '/signal';
const MAX_ROOM_AGE_MS = 24 * 60 * 60 * 1000;
const ROOM_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;
const rooms = new Map();
const attempts = new Map();

const server = http.createServer((request, response) => {
  if (request.url === '/' || request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('Entre Nous rendezvous is running. No messages are stored here.\n');
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found\n');
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024,
  perMessageDeflate: false
});

function send(socket, message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function fail(socket, message) {
  send(socket, { type: 'error', message });
  try { socket.close(1008, 'Request refused'); } catch { /* ignore */ }
}
function getIp(request) {
  // Le service n'est exposé qu'au réseau Docker derrière Caddy ; Caddy remplace ce champ
  // par l'adresse du client et retire les valeurs X-Forwarded-For fournies par l'extérieur.
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length < 200) return forwarded.split(',')[0].trim();
  return request.socket.remoteAddress || 'unknown';
}
function allowAttempt(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((stamp) => now - stamp < 5 * 60 * 1000);
  if (recent.length >= 40) return false;
  recent.push(now);
  attempts.set(ip, recent);
  return true;
}
function sendSignalToOther(socket, data) {
  if (!socket.roomId || !socket.role) return;
  const room = rooms.get(socket.roomId);
  if (!room) return;
  const other = socket.role === 'host' ? room.guest : room.host;
  if (!other) return;
  if (!data || typeof data !== 'object') return;
  if (data.kind === 'description') {
    const description = data.description;
    if (!description || !['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string' || description.sdp.length > 30000) return;
  } else if (data.kind === 'ice') {
    const candidate = data.candidate;
    if (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 3000) return;
  } else {
    return;
  }
  send(other, { type: 'signal', data });
}

wss.on('connection', (socket, request) => {
  socket.isAlive = true;
  socket.roomId = null;
  socket.role = null;
  socket.on('pong', () => {
    socket.isAlive = true;
    const activeRoom = socket.roomId ? rooms.get(socket.roomId) : null;
    if (activeRoom) activeRoom.lastActivity = Date.now();
  });

  socket.on('message', (raw, isBinary) => {
    if (isBinary || raw.length > 40 * 1024) return fail(socket, 'Message de signalisation invalide.');
    let message;
    try { message = JSON.parse(raw.toString('utf8')); }
    catch { return fail(socket, 'Format de message invalide.'); }

    if (!socket.role) {
      if (!allowAttempt(getIp(request))) return fail(socket, 'Trop de tentatives. Réessaie plus tard.');
      if (!message || !['create', 'join'].includes(message.type) || typeof message.room !== 'string' || !ROOM_PATTERN.test(message.room) || typeof message.proof !== 'string' || !/^[a-f0-9]{64}$/.test(message.proof)) {
        return fail(socket, 'Code de session invalide.');
      }
      const roomId = message.room;
      if (message.type === 'create') {
        if (rooms.has(roomId)) return fail(socket, 'Ce code existe déjà. Crée une nouvelle session.');
        const room = { host: socket, guest: null, proof: Buffer.from(message.proof, 'hex'), createdAt: Date.now(), lastActivity: Date.now() };
        rooms.set(roomId, room);
        socket.roomId = roomId;
        socket.role = 'host';
        send(socket, { type: 'created' });
        return;
      }
      const room = rooms.get(roomId);
      if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) return fail(socket, 'Session introuvable ou expirée. Demande un nouveau code.');
      if (room.guest) return fail(socket, 'Cette session est déjà complète.');
      const suppliedProof = Buffer.from(message.proof, 'hex');
      if (suppliedProof.length !== room.proof.length || !crypto.timingSafeEqual(suppliedProof, room.proof)) return fail(socket, 'Code secret incorrect. Vérifie le code d’invitation.');
      room.guest = socket;
      room.lastActivity = Date.now();
      socket.roomId = roomId;
      socket.role = 'guest';
      send(socket, { type: 'joined' });
      send(room.host, { type: 'peer-joined' });
      return;
    }

    if (message?.type === 'signal') sendSignalToOther(socket, message.data);
  });

  socket.on('close', () => {
    const room = socket.roomId ? rooms.get(socket.roomId) : null;
    if (!room) return;
    if (socket.role === 'host') {
      send(room.guest, { type: 'peer-left' });
      rooms.delete(socket.roomId);
    } else if (socket.role === 'guest') {
      room.guest = null;
      send(room.host, { type: 'peer-left' });
    }
  });
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  const origin = request.headers.origin;
  // The desktop client loads from file://. Reject browser origins unless explicitly allowed.
  const allowedOrigins = new Set(['file://', 'null', ...(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
  if (url.pathname !== PATH || (origin && !allowedOrigins.has(origin))) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (now - room.lastActivity > MAX_ROOM_AGE_MS || room.host.readyState !== WebSocket.OPEN) {
      send(room.guest, { type: 'peer-left' });
      rooms.delete(roomId);
    }
  }
  for (const socket of wss.clients) {
    if (socket.isAlive === false) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
  for (const [ip, stamps] of attempts) {
    const recent = stamps.filter((stamp) => now - stamp < 5 * 60 * 1000);
    if (recent.length) attempts.set(ip, recent); else attempts.delete(ip);
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`Entre Nous rendezvous listening on ${PORT}${PATH}\n`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const socket of wss.clients) socket.close(1001, 'Server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
