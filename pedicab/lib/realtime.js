// Real-time messaging over WebSockets. Riders and drivers each open a socket
// and identify themselves; the server pushes ride offers, status changes, and
// live location updates to the right party.
//
// A client identifies with: { type: 'identify', role: 'driver'|'rider', id }

import { WebSocketServer } from 'ws';

// role:id -> Set<WebSocket> (a user may have more than one tab/device open)
const sockets = new Map();

const key = (role, id) => `${role}:${id}`;

function register(role, id, ws) {
  const k = key(role, id);
  if (!sockets.has(k)) sockets.set(k, new Set());
  sockets.get(k).add(ws);
  ws._pedicab = { role, id, k };
}

function unregister(ws) {
  const meta = ws._pedicab;
  if (!meta) return;
  const set = sockets.get(meta.k);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) sockets.delete(meta.k);
}

// Push an event to a specific user (all their open sockets).
export function sendTo(role, id, event, payload) {
  const set = sockets.get(key(role, id));
  if (!set) return false;
  const msg = JSON.stringify({ event, ...payload });
  let delivered = false;
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) { ws.send(msg); delivered = true; }
  }
  return delivered;
}

export const sendToDriver = (id, event, payload) => sendTo('driver', id, event, payload);
export const sendToRider  = (id, event, payload) => sendTo('rider', id, event, payload);

// Attach a WebSocket server to an existing HTTP server on /ws.
export function attachRealtime(httpServer, { onMessage } = {}) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'identify' && msg.role && msg.id) {
        register(msg.role, msg.id, ws);
        ws.send(JSON.stringify({ event: 'identified', role: msg.role, id: msg.id }));
        return;
      }
      if (msg.type === 'ping') { ws.send(JSON.stringify({ event: 'pong' })); return; }
      if (onMessage) onMessage(msg, ws);
    });

    ws.on('close', () => unregister(ws));
    ws.on('error', () => unregister(ws));
  });

  return wss;
}
