// Entre Nous : service de mise en relation (signalisation WebRTC) pour Cloudflare Workers.
// Une "Room" (Durable Object) par code de session. Aucun message de conversation n'y passe :
// seulement les descriptions SDP et candidats ICE, chiffrés plus tard de bout en bout par WebRTC.

const ROOM_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;
const PROOF_PATTERN = /^[a-f0-9]{64}$/;
const BASE_ORIGINS = ['file://', 'null']; // l'application de bureau charge sa page depuis file://
const MAX_ROOM_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FAILED_JOINS = 15;
const MAX_SOCKETS = 4;
const UNAUTH_TIMEOUT_MS = 30 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('Entre Nous rendezvous is running. No messages are stored here.\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
      });
    }
    if (url.pathname !== '/signal') return new Response('Not found\n', { status: 404 });
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('WebSocket requis\n', { status: 426 });
    }

    const allowed = new Set([...BASE_ORIGINS, ...String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
    const origin = request.headers.get('Origin');
    if (origin && !allowed.has(origin)) return new Response('Forbidden\n', { status: 403 });

    const room = url.searchParams.get('room') || '';
    if (!ROOM_PATTERN.test(room)) return new Response('Code de session invalide\n', { status: 400 });

    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    return stub.fetch(request);
  }
};

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Keepalive du client : répondu sans réveiller l'objet (donc sans coût).
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const roomName = url.searchParams.get('room') || '';
    const now = Date.now();

    // Nettoie les connexions qui n'ont jamais présenté de code, puis limite le nombre total.
    for (const s of this.ctx.getWebSockets()) {
      const att = s.deserializeAttachment() || {};
      if (!att.role && now - (att.connectedAt || 0) > UNAUTH_TIMEOUT_MS) {
        try { s.close(1008, 'Timeout'); } catch { /* ignore */ }
      }
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response('Session occupée\n', { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: null, room: roomName, connectedAt: now });
    return new Response(null, { status: 101, webSocket: client });
  }

  send(socket, message) {
    try { if (socket && socket.readyState === 1) socket.send(JSON.stringify(message)); } catch { /* ignore */ }
  }

  fail(socket, message) {
    this.send(socket, { type: 'error', message });
    try { socket.close(1008, 'Request refused'); } catch { /* ignore */ }
  }

  find(role, except) {
    return this.ctx.getWebSockets().find((s) => s !== except && s.readyState === 1 && (s.deserializeAttachment() || {}).role === role) || null;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 40 * 1024) return this.fail(ws, 'Message de signalisation invalide.');
    let message;
    try { message = JSON.parse(raw); } catch { return this.fail(ws, 'Format de message invalide.'); }

    const att = ws.deserializeAttachment() || {};
    if (!att.role) return this.handshake(ws, att, message);
    if (message && message.type === 'signal') this.relay(ws, att.role, message.data);
  }

  async handshake(ws, att, message) {
    if (!message || !['create', 'join'].includes(message.type) ||
        typeof message.room !== 'string' || message.room !== att.room || !ROOM_PATTERN.test(message.room) ||
        typeof message.proof !== 'string' || !PROOF_PATTERN.test(message.proof)) {
      return this.fail(ws, 'Code de session invalide.');
    }
    const storage = this.ctx.storage;

    if (message.type === 'create') {
      const stored = await storage.get('proof');
      if (stored && this.find('host', ws)) return this.fail(ws, 'Ce code existe déjà. Crée une nouvelle session.');
      await storage.deleteAll();
      await storage.put({ proof: message.proof, createdAt: Date.now() });
      await storage.setAlarm(Date.now() + MAX_ROOM_AGE_MS);
      ws.serializeAttachment({ ...att, role: 'host' });
      this.send(ws, { type: 'created' });
      return;
    }

    // join
    const [stored, fails] = await Promise.all([storage.get('proof'), storage.get('fails')]);
    const host = this.find('host', ws);
    if (!stored || !host) return this.fail(ws, 'Session introuvable ou expirée. Demande un nouveau code.');
    if ((fails || 0) >= MAX_FAILED_JOINS) return this.fail(ws, 'Trop de tentatives. Demande un nouveau code.');
    if (this.find('guest', ws)) return this.fail(ws, 'Cette session est déjà complète.');
    if (!safeEqualHex(message.proof, stored)) {
      await storage.put('fails', (fails || 0) + 1);
      return this.fail(ws, 'Code secret incorrect. Vérifie le code d’invitation.');
    }
    ws.serializeAttachment({ ...att, role: 'guest' });
    this.send(ws, { type: 'joined' });
    this.send(host, { type: 'peer-joined' });
  }

  relay(ws, role, data) {
    const other = this.find(role === 'host' ? 'guest' : 'host', ws);
    if (!other || !data || typeof data !== 'object') return;
    if (data.kind === 'description') {
      const d = data.description;
      if (!d || !['offer', 'answer'].includes(d.type) || typeof d.sdp !== 'string' || d.sdp.length > 30000) return;
    } else if (data.kind === 'ice') {
      const c = data.candidate;
      if (!c || typeof c.candidate !== 'string' || c.candidate.length > 3000) return;
    } else {
      return;
    }
    this.send(other, { type: 'signal', data });
  }

  async leave(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.role === 'host') {
      const guest = this.find('guest', ws);
      this.send(guest, { type: 'peer-left' });
      try { if (guest) guest.close(1000, 'Host left'); } catch { /* ignore */ }
      await this.ctx.storage.deleteAll();
    } else if (att.role === 'guest') {
      this.send(this.find('host', ws), { type: 'peer-left' });
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* ignore */ }
    await this.leave(ws);
  }

  async webSocketError(ws) {
    try { ws.close(); } catch { /* ignore */ }
    await this.leave(ws);
  }

  async alarm() {
    for (const s of this.ctx.getWebSockets()) {
      this.send(s, { type: 'peer-left' });
      try { s.close(1000, 'Session expirée'); } catch { /* ignore */ }
    }
    await this.ctx.storage.deleteAll();
  }
}
