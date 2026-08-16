import {
  api, idStore, connectRealtime, geocode, reverseGeocode, getConfig, money,
  toast, locate, makeMap, setMarker, ICON,
} from '/js/shared.js';

const sheet = document.getElementById('sheet');
const connBadge = document.getElementById('conn');
const whoEl = document.getElementById('who');

let cfg, rider, map, socket;
let markers = { pickup: null, dropoff: null, cab: null };
let pickup = null, dropoff = null;
let pickupLabel = '', dropoffLabel = '';
let activeRide = null;
let picking = 'pickup'; // which point a map tap sets next

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async function init() {
  cfg = await getConfig();
  rider = idStore.get('pedigo_rider');
  if (!rider) return renderSignup();
  await startRiding();
})();

async function startRiding() {
  whoEl.textContent = `Hi, ${rider.name}`;
  const here = await locate();
  pickup = here;
  pickupLabel = 'Current location';

  map = makeMap('map', here);
  markers.pickup = setMarker(map, null, pickup, ICON.pickup);
  map.on('click', onMapClick);
  reverseGeocode(here).then((lbl) => { pickupLabel = lbl; if (!activeRide) renderRequest(); });

  socket = connectRealtime({ role: 'rider', id: rider.id, onEvent: handleEvent });

  // Resume an in-flight ride after a refresh.
  const saved = idStore.get('pedigo_active_ride');
  if (saved) {
    try {
      const { ride } = await api.get(`/api/rides/${saved}`);
      if (ride && !['completed', 'cancelled', 'no_drivers'].includes(ride.status)) {
        activeRide = ride; renderActive();
      } else { idStore.clear('pedigo_active_ride'); renderRequest(); }
    } catch { idStore.clear('pedigo_active_ride'); renderRequest(); }
  } else {
    renderRequest();
  }
}

// ─── Signup ───────────────────────────────────────────────────────────────────

function renderSignup() {
  connBadge.textContent = '';
  sheet.innerHTML = `
    <h2>Welcome to PediGo 🚲</h2>
    <p class="hint">Tell us your name to get started. No password needed for this demo.</p>
    <label class="field"><span>Your name</span><input id="name" type="text" placeholder="e.g. Sam" /></label>
    <label class="field"><span>Phone (optional)</span><input id="phone" type="tel" placeholder="555-0100" /></label>
    <button class="primary" id="go">Start riding</button>
  `;
  document.getElementById('go').onclick = async () => {
    const name = document.getElementById('name').value.trim() || 'Guest';
    const phone = document.getElementById('phone').value.trim();
    const { rider: r } = await api.post('/api/riders', { name, phone });
    rider = r; idStore.set('pedigo_rider', r);
    await startRiding();
  };
}

// ─── Map interaction ──────────────────────────────────────────────────────────

async function onMapClick(e) {
  const c = { lat: e.latlng.lat, lng: e.latlng.lng };
  if (activeRide) return;
  if (picking === 'pickup') {
    pickup = c; markers.pickup = setMarker(map, markers.pickup, c, ICON.pickup);
    pickupLabel = await reverseGeocode(c);
  } else {
    dropoff = c; markers.dropoff = setMarker(map, markers.dropoff, c, ICON.dropoff);
    dropoffLabel = await reverseGeocode(c);
  }
  renderRequest();
}

// ─── Request screen ───────────────────────────────────────────────────────────

function renderRequest() {
  sheet.innerHTML = `
    <h2>Where to?</h2>
    <p class="hint">Search an address or tap the map. Green = pickup, flag = destination.</p>

    <label class="field"><span>Pickup</span>
      <input id="pk" type="search" placeholder="Search pickup…" value="${escapeAttr(pickupLabel)}" />
    </label>
    <div id="pkres"></div>

    <label class="field"><span>Destination</span>
      <input id="dp" type="search" placeholder="Search destination…" value="${escapeAttr(dropoffLabel)}" />
    </label>
    <div id="dpres"></div>

    <div id="fare"></div>

    <button class="primary" id="req" ${pickup && dropoff ? '' : 'disabled'}>
      ${pickup && dropoff ? 'See fare & request pedicab' : 'Set pickup and destination'}
    </button>
  `;
  wireSearch('pk', 'pkres', 'pickup');
  wireSearch('dp', 'dpres', 'dropoff');
  document.getElementById('pk').addEventListener('focus', () => { picking = 'pickup'; });
  document.getElementById('dp').addEventListener('focus', () => { picking = 'dropoff'; });

  if (pickup && dropoff) showEstimate();
  document.getElementById('req').onclick = requestRide;
}

function wireSearch(inputId, resId, which) {
  const input = document.getElementById(inputId);
  const resBox = document.getElementById(resId);
  let t;
  input.addEventListener('input', () => {
    picking = which;
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 3) { resBox.innerHTML = ''; return; }
    t = setTimeout(async () => {
      const rows = await geocode(q, pickup);
      resBox.innerHTML = rows.map((r, i) =>
        `<div class="card small" style="cursor:pointer;margin:4px 0;padding:10px" data-i="${i}">${escapeHtml(r.label)}</div>`
      ).join('');
      resBox.querySelectorAll('[data-i]').forEach((el) => {
        el.onclick = () => {
          const r = rows[+el.dataset.i];
          const c = { lat: r.lat, lng: r.lng };
          if (which === 'pickup') { pickup = c; pickupLabel = r.label; markers.pickup = setMarker(map, markers.pickup, c, ICON.pickup); }
          else { dropoff = c; dropoffLabel = r.label; markers.dropoff = setMarker(map, markers.dropoff, c, ICON.dropoff); }
          fitPoints();
          renderRequest();
        };
      });
    }, 350);
  });
}

async function showEstimate() {
  const box = document.getElementById('fare');
  if (!box) return;
  box.innerHTML = `<div class="card"><div class="kv"><span class="k">Estimating fare…</span></div></div>`;
  try {
    const { estimate: e } = await api.post('/api/fare/estimate', { pickup, dropoff });
    box.innerHTML = `
      <div class="card">
        <div class="kv"><span class="k">Distance</span><span class="v">${e.distanceKm} km</span></div>
        <div class="kv"><span class="k">Est. time</span><span class="v">${Math.round(e.durationMin)} min</span></div>
        <div class="kv"><span class="k">Base fare</span><span class="v">${money(e.baseFare, cfg)}</span></div>
        <div class="kv"><span class="k">Distance + time</span><span class="v">${money(e.distanceCost + e.timeCost, cfg)}</span></div>
        <div class="kv total"><span class="k">Estimated total</span><span class="v">${money(e.total, cfg)}</span></div>
      </div>`;
    fitPoints();
  } catch (err) { box.innerHTML = `<p class="small muted">Couldn't estimate fare: ${err.message}</p>`; }
}

function fitPoints() {
  if (pickup && dropoff && map) {
    map.fitBounds(L.latLngBounds([pickup, dropoff].map((c) => [c.lat, c.lng])), { padding: [60, 60], maxZoom: 16 });
  }
}

async function requestRide() {
  try {
    const { ride } = await api.post('/api/rides', {
      riderId: rider.id, pickup, dropoff,
      pickupAddress: pickupLabel, dropoffAddress: dropoffLabel,
    });
    activeRide = ride;
    idStore.set('pedigo_active_ride', ride.id);
    renderActive();
  } catch (err) { toast(err.message); }
}

// ─── Active ride ──────────────────────────────────────────────────────────────

const STATUS_TEXT = {
  offering: ['Finding you a pedicab…', 'pulse'],
  no_drivers: ['No pedicabs available nearby', ''],
  accepted: ['Pedicab on the way to you', 'pulse'],
  arrived: ['Your pedicab has arrived!', 'ok'],
  in_progress: ['Enjoy the ride', 'ok'],
  completed: ['Ride complete', 'ok'],
  cancelled: ['Ride cancelled', ''],
};

function renderActive() {
  const r = activeRide;
  const [label, dot] = STATUS_TEXT[r.status] || [r.status, ''];

  // Draw pickup/dropoff.
  markers.pickup = setMarker(map, markers.pickup, r.pickup, ICON.pickup);
  markers.dropoff = setMarker(map, markers.dropoff, r.dropoff, ICON.dropoff);

  let driverBlock = '';
  if (r.driver) {
    driverBlock = `
      <div class="card driver-line">
        <div class="avatar">🚲</div>
        <div style="flex:1">
          <div class="name">${escapeHtml(r.driver.cabName)} · ${escapeHtml(r.driver.name)}</div>
          <div class="meta">${r.driver.ratingAvg ? '★ ' + r.driver.ratingAvg : 'New driver'}</div>
        </div>
      </div>`;
    markers.cab = setMarker(map, markers.cab, r.driver.location, ICON.pedicab);
  }

  let action = '';
  if (r.status === 'no_drivers') {
    action = `<button class="primary" id="retry">Try again</button>`;
  } else if (['offering', 'accepted', 'arrived'].includes(r.status)) {
    action = `<button class="danger" id="cancel">Cancel ride</button>`;
  } else if (r.status === 'completed') {
    return renderReceiptAndRate();
  } else if (r.status === 'cancelled') {
    action = `<button class="primary" id="again">Book another ride</button>`;
  }

  sheet.innerHTML = `
    <div class="status"><span class="dot ${dot}"></span>${label}</div>
    <div class="card">
      <div class="kv"><span class="k">From</span><span class="v" style="max-width:60%;text-align:right">${escapeHtml(r.pickupAddress || 'Pickup')}</span></div>
      <div class="kv"><span class="k">To</span><span class="v" style="max-width:60%;text-align:right">${escapeHtml(r.dropoffAddress || 'Destination')}</span></div>
      <div class="kv total"><span class="k">${r.status === 'completed' ? 'Fare' : 'Est. fare'}</span><span class="v">${money((r.fare?.total ?? r.estimate.total), cfg)}</span></div>
    </div>
    ${driverBlock}
    ${action}
  `;

  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('cancel', async () => { await api.post(`/api/rides/${r.id}/cancel`, { by: 'rider' }); });
  on('retry', () => { idStore.clear('pedigo_active_ride'); activeRide = null; renderRequest(); });
  on('again', () => { idStore.clear('pedigo_active_ride'); activeRide = null; dropoff = null; dropoffLabel=''; markers.dropoff && map.removeLayer(markers.dropoff); markers.dropoff=null; markers.cab && map.removeLayer(markers.cab); markers.cab=null; renderRequest(); });
}

function renderReceiptAndRate() {
  const r = activeRide;
  const f = r.fare;
  sheet.innerHTML = `
    <div class="status"><span class="dot ok"></span>Ride complete — thanks for riding!</div>
    <div class="card">
      <div class="kv"><span class="k">Distance</span><span class="v">${f.distanceKm} km</span></div>
      <div class="kv"><span class="k">Time</span><span class="v">${Math.round(f.durationMin)} min</span></div>
      <div class="kv total"><span class="k">Total paid</span><span class="v">${money(f.total, cfg)}</span></div>
    </div>
    <p class="hint" style="text-align:center">Rate ${escapeHtml(r.driver?.name || 'your driver')}</p>
    <div class="stars" id="stars">${[1,2,3,4,5].map((i)=>`<span data-s="${i}">★</span>`).join('')}</div>
    <button class="primary" id="done" disabled>Submit rating</button>
    <button class="ghost" id="skip" style="margin-top:10px">Skip</button>
  `;
  let chosen = 0;
  const stars = [...document.querySelectorAll('#stars span')];
  stars.forEach((s) => {
    s.onclick = () => { chosen = +s.dataset.s; stars.forEach((x,i)=>x.classList.toggle('lit', i<chosen)); document.getElementById('done').disabled = false; };
  });
  const finish = () => { idStore.clear('pedigo_active_ride'); activeRide = null; markers.cab && map.removeLayer(markers.cab); markers.cab=null; renderRequest(); };
  document.getElementById('done').onclick = async () => {
    try { await api.post(`/api/rides/${r.id}/rate`, { stars: chosen }); toast('Thanks for the rating!'); } catch {}
    finish();
  };
  document.getElementById('skip').onclick = finish;
}

// ─── Realtime events ──────────────────────────────────────────────────────────

function handleEvent(msg) {
  if (msg.event === 'identified') { connBadge.textContent = 'live'; connBadge.className = 'badge on'; return; }
  if (msg.event === 'ride_update') {
    activeRide = msg.ride;
    renderActive();
  }
  if (msg.event === 'driver_location' && activeRide && msg.rideId === activeRide.id) {
    if (activeRide.driver) activeRide.driver.location = msg.location;
    markers.cab = setMarker(map, markers.cab, msg.location, ICON.pedicab);
  }
}

// ─── utils ────────────────────────────────────────────────────────────────────
function escapeHtml(s='') { return s.replace(/[&<>"']/g, (c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s='') { return escapeHtml(s); }
