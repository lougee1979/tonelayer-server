// Shared client helpers: REST wrapper, realtime socket, geocoding, UI bits.

export const api = {
  async call(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  },
  get: (p) => api.call('GET', p),
  post: (p, b) => api.call('POST', p, b),
};

// Persisted local identity (rider or driver) so a refresh keeps you signed in.
export const idStore = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  clear: (k) => localStorage.removeItem(k),
};

// Realtime connection to the server, with auto-reconnect + identify.
export function connectRealtime({ role, id, onEvent }) {
  let ws, alive = true, retry = 0;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => { retry = 0; ws.send(JSON.stringify({ type: 'identify', role, id })); };
    ws.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { if (alive) setTimeout(open, Math.min(1000 * 2 ** retry++, 8000)); };
    ws.onerror = () => ws.close();
  };
  open();
  return {
    send: (obj) => ws?.readyState === 1 && ws.send(JSON.stringify(obj)),
    close: () => { alive = false; ws?.close(); },
  };
}

// Forward geocode an address string → coordinates via OpenStreetMap Nominatim.
// Free, works in any city, no API key. Light demo use only.
export async function geocode(query, near) {
  const params = new URLSearchParams({ q: query, format: 'json', limit: '5', addressdetails: '1' });
  if (near) params.set('viewbox', `${near.lng - .1},${near.lat + .1},${near.lng + .1},${near.lat - .1}`);
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'Accept-Language': navigator.language || 'en' },
  });
  if (!res.ok) return [];
  const rows = await res.json();
  return rows.map((r) => ({ label: r.display_name, lat: +r.lat, lng: +r.lon }));
}

// Reverse geocode coords → a short human label (best effort).
export async function reverseGeocode({ lat, lng }) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18`);
    const r = await res.json();
    const a = r.address || {};
    return [a.house_number, a.road || a.pedestrian || a.neighbourhood, a.suburb || a.city_district]
      .filter(Boolean).join(' ') || r.display_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch { return `${lat.toFixed(4)}, ${lng.toFixed(4)}`; }
}

let cfgCache = null;
export async function getConfig() {
  if (!cfgCache) cfgCache = (await api.get('/api/config'));
  return cfgCache;
}
export const money = (n, cfg) => `${cfg?.currencySymbol || '$'}${Number(n).toFixed(2)}`;

// Tiny toast.
let toastEl;
export function toast(msg, ms = 2600) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// Browser geolocation → Promise<{lat,lng}>, falling back to a default city center.
export function locate(fallback = { lat: 40.7580, lng: -73.9855 }) { // Times Square
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(fallback);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(fallback),
      { enableHighAccuracy: true, timeout: 6000 },
    );
  });
}

// ─── Leaflet map helpers ──────────────────────────────────────────────────────

export function makeMap(elId, center) {
  const map = L.map(elId, { zoomControl: true, attributionControl: true }).setView([center.lat, center.lng], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap contributors',
  }).addTo(map);
  return map;
}

const emojiIcon = (emoji) => L.divIcon({
  html: `<div style="font-size:28px;line-height:28px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))">${emoji}</div>`,
  className: 'emoji-marker', iconSize: [28, 28], iconAnchor: [14, 14],
});
// Lazy getters: the icons touch Leaflet's `L` only when read (on a map page),
// so pages without a map (landing, platform dashboard) can still import this.
export const ICON = {
  get pickup()  { return emojiIcon('🟢'); },
  get dropoff() { return emojiIcon('🏁'); },
  get pedicab() { return emojiIcon('🚲'); },
  get rider()   { return emojiIcon('🧍'); },
};

export function setMarker(map, existing, coord, icon, opts = {}) {
  if (!coord) { if (existing) map.removeLayer(existing); return null; }
  if (existing) { existing.setLatLng([coord.lat, coord.lng]); return existing; }
  return L.marker([coord.lat, coord.lng], { icon, ...opts }).addTo(map);
}
