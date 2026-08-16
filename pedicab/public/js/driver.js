import {
  api, idStore, connectRealtime, getConfig, money,
  toast, locate, makeMap, setMarker, ICON,
} from '/js/shared.js';

const sheet = document.getElementById('sheet');
const statusBadge = document.getElementById('statusBadge');
const whoEl = document.getElementById('who');

let cfg, driver, map, socket;
let markers = { me: null, pickup: null, dropoff: null };
let online = false;
let myLoc = null;
let currentRide = null;      // ride being served
let offer = null;            // pending offer { ride, ... }
let offerTimer = null;
let locWatch = null;         // geolocation watch id
let locHeartbeat = null;     // interval that re-pushes position

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async function init() {
  cfg = await getConfig();
  driver = idStore.get('pedigo_driver');
  if (!driver) return renderRegister();
  await refreshDriver();
  await startDriving();
})();

async function refreshDriver() {
  try {
    const { driver: d } = await api.get(`/api/drivers/${driver.id}`);
    driver = d; idStore.set('pedigo_driver', { id: d.id, name: d.name, cabName: d.cabName });
  } catch { idStore.clear('pedigo_driver'); driver = null; }
}

async function startDriving() {
  if (!driver) return renderRegister();
  whoEl.textContent = `${driver.cabName} · ${driver.name}`;
  myLoc = await locate();
  map = makeMap('map', myLoc);
  markers.me = setMarker(map, null, myLoc, ICON.pedicab);

  socket = connectRealtime({ role: 'driver', id: driver.id, onEvent: handleEvent });
  renderHome();
}

// ─── Register ─────────────────────────────────────────────────────────────────

function renderRegister() {
  sheet.innerHTML = `
    <h2>Drive with PediGo 🚲</h2>
    <p class="hint">Register your pedicab. Membership is ${money(cfg.billing.monthlyFee, cfg)}/month, and the platform keeps ${Math.round(cfg.billing.commissionRate*100)}% of each fare — you keep the rest.</p>
    <label class="field"><span>Your name</span><input id="name" type="text" placeholder="e.g. Alex" /></label>
    <label class="field"><span>Pedicab name</span><input id="cab" type="text" placeholder="e.g. Sunset Cycle Cab" /></label>
    <label class="field"><span>Phone (optional)</span><input id="phone" type="tel" placeholder="555-0100" /></label>
    <button class="primary" id="go">Create driver account</button>
  `;
  document.getElementById('go').onclick = async () => {
    const name = document.getElementById('name').value.trim() || 'Driver';
    const cabName = document.getElementById('cab').value.trim() || 'Pedicab';
    const phone = document.getElementById('phone').value.trim();
    const { driver: d } = await api.post('/api/drivers', { name, cabName, phone });
    driver = d; idStore.set('pedigo_driver', { id: d.id, name: d.name, cabName: d.cabName });
    await startDriving();
  };
}

// ─── Home / membership / go online ────────────────────────────────────────────

async function renderHome() {
  await refreshDriver();
  const active = isActive(driver);
  const sub = driver.subscription;

  if (currentRide) return renderTrip();
  if (offer) return renderOffer();

  let membershipCard;
  if (active) {
    const days = Math.max(0, Math.ceil((sub.activeUntil - Date.now()) / 86400000));
    membershipCard = `
      <div class="card">
        <div class="kv"><span class="k">Membership</span><span class="v" style="color:var(--ok)">Active</span></div>
        <div class="kv"><span class="k">Renews in</span><span class="v">${days} day${days===1?'':'s'}</span></div>
      </div>`;
  } else {
    membershipCard = `
      <div class="card offer">
        <div class="kv"><span class="k">Membership</span><span class="v" style="color:var(--danger)">Inactive</span></div>
        <p class="hint" style="margin:8px 0 12px">Pay the monthly fee to go online and start receiving rides.</p>
        <button class="primary" id="pay">Pay ${money(cfg.billing.monthlyFee, cfg)} membership</button>
      </div>`;
  }

  const e = driver.earnings;
  sheet.innerHTML = `
    <h2>${online ? 'You’re online' : 'Ready to drive'}</h2>
    <p class="hint">${online ? 'Waiting for ride requests nearby…' : 'Go online to start receiving pedicab ride requests.'}</p>
    ${membershipCard}

    <div class="card">
      <div class="kv"><span class="k">Rides completed</span><span class="v">${e.ridesCompleted}</span></div>
      <div class="kv"><span class="k">Gross fares</span><span class="v">${money(e.grossFares, cfg)}</span></div>
      <div class="kv"><span class="k">Platform fees (−${Math.round(cfg.billing.commissionRate*100)}%)</span><span class="v" style="color:var(--muted)">−${money(e.platformCommission, cfg)}</span></div>
      <div class="kv total"><span class="k">Your earnings</span><span class="v">${money(e.netPayout, cfg)}</span></div>
    </div>

    ${active ? `<button class="${online ? 'danger' : 'ok'}" id="toggle">${online ? 'Go offline' : 'Go online'}</button>` : ''}
  `;

  const pay = document.getElementById('pay');
  if (pay) pay.onclick = payMembership;
  const toggle = document.getElementById('toggle');
  if (toggle) toggle.onclick = () => online ? goOffline() : goOnline();
}

async function payMembership() {
  try {
    await api.post(`/api/drivers/${driver.id}/subscribe`, {});
    toast('Membership active — you can go online now');
    await renderHome();
  } catch (err) { toast(err.message); }
}

async function goOnline() {
  myLoc = await locate(myLoc);
  try {
    await api.post(`/api/drivers/${driver.id}/status`, { status: 'online', location: myLoc });
    online = true;
    statusBadge.textContent = 'online'; statusBadge.className = 'badge on';
    startLocationUpdates();
    await renderHome();
  } catch (err) { toast(err.message); }
}

async function goOffline() {
  stopLocationUpdates();
  try { await api.post(`/api/drivers/${driver.id}/status`, { status: 'offline' }); } catch {}
  online = false;
  statusBadge.textContent = 'offline'; statusBadge.className = 'badge off';
  await renderHome();
}

function startLocationUpdates() {
  if (locHeartbeat != null) return;
  const push = async (loc) => {
    myLoc = loc;
    markers.me = setMarker(map, markers.me, loc, ICON.pedicab);
    try { await api.post(`/api/drivers/${driver.id}/location`, { location: loc }); } catch {}
  };
  if (navigator.geolocation) {
    locWatch = navigator.geolocation.watchPosition(
      (p) => push({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {}, { enableHighAccuracy: true, maximumAge: 4000 },
    );
  }
  // Heartbeat so the rider's map stays fresh even without GPS movement.
  locHeartbeat = setInterval(() => myLoc && push(myLoc), 5000);
}
function stopLocationUpdates() {
  if (locWatch != null) { navigator.geolocation.clearWatch(locWatch); locWatch = null; }
  if (locHeartbeat != null) { clearInterval(locHeartbeat); locHeartbeat = null; }
}

// ─── Ride offer ───────────────────────────────────────────────────────────────

function renderOffer() {
  const o = offer;
  const r = o.ride;
  markers.pickup = setMarker(map, markers.pickup, r.pickup, ICON.pickup);
  markers.dropoff = setMarker(map, markers.dropoff, r.dropoff, ICON.dropoff);
  if (myLoc && r.pickup) map.fitBounds(L.latLngBounds([[myLoc.lat,myLoc.lng],[r.pickup.lat,r.pickup.lng],[r.dropoff.lat,r.dropoff.lng]]), { padding:[50,50], maxZoom:16 });

  const est = r.estimate;
  const yourCut = money(est.total * (1 - cfg.billing.commissionRate), cfg);
  sheet.innerHTML = `
    <div class="status"><span class="dot pulse"></span>New ride request</div>
    <div class="card offer">
      <div class="fare-big">${money(est.total, cfg)}</div>
      <div class="small muted">You keep ~${yourCut} after the ${Math.round(cfg.billing.commissionRate*100)}% platform fee</div>
      <div class="countdown"><i id="cbar"></i></div>
      <div class="kv"><span class="k">Pickup</span><span class="v" style="max-width:60%;text-align:right">${escapeHtml(r.pickupAddress || 'Pickup')}</span></div>
      <div class="kv"><span class="k">To pickup</span><span class="v">${o.pickupDistanceKm} km · ~${o.pickupEtaMin} min</span></div>
      <div class="kv"><span class="k">Trip</span><span class="v">${est.distanceKm} km · ~${Math.round(est.durationMin)} min</span></div>
    </div>
    <div class="btns">
      <button class="ghost" id="decline">Decline</button>
      <button class="ok" id="accept">Accept ride</button>
    </div>
  `;
  // Countdown bar
  const bar = document.getElementById('cbar');
  const total = o.expiresInMs || 20000;
  const started = Date.now();
  clearInterval(offerTimer);
  offerTimer = setInterval(() => {
    const left = Math.max(0, total - (Date.now() - started));
    bar.style.width = (left / total * 100) + '%';
    if (left <= 0) { clearInterval(offerTimer); }
  }, 100);

  document.getElementById('accept').onclick = async () => {
    try {
      const { ride } = await api.post(`/api/rides/${r.id}/accept`, { driverId: driver.id });
      offer = null; clearInterval(offerTimer);
      currentRide = ride; renderTrip();
    } catch (err) { toast(err.message); offer = null; clearInterval(offerTimer); renderHome(); }
  };
  document.getElementById('decline').onclick = async () => {
    await api.post(`/api/rides/${r.id}/decline`, { driverId: driver.id });
    offer = null; clearInterval(offerTimer); clearTripMarkers(); renderHome();
  };
}

// ─── Active trip ──────────────────────────────────────────────────────────────

const TRIP = {
  accepted: { text: 'Head to pickup', action: 'I’ve arrived', next: 'arrive', cls: 'primary' },
  arrived:  { text: 'Pick up your rider', action: 'Start trip', next: 'start', cls: 'ok' },
  in_progress: { text: 'Trip in progress', action: 'Complete ride', next: 'complete', cls: 'ok' },
};

function renderTrip() {
  const r = currentRide;
  markers.pickup = setMarker(map, markers.pickup, r.pickup, ICON.pickup);
  markers.dropoff = setMarker(map, markers.dropoff, r.dropoff, ICON.dropoff);

  if (r.status === 'completed') return renderTripDone();
  if (r.status === 'cancelled') {
    toast('Rider cancelled the ride');
    currentRide = null; clearTripMarkers(); return renderHome();
  }

  const step = TRIP[r.status];
  const target = r.status === 'in_progress' ? r.dropoffAddress : r.pickupAddress;
  sheet.innerHTML = `
    <div class="status"><span class="dot ok"></span>${step.text}</div>
    <div class="card">
      <div class="kv"><span class="k">${r.status === 'in_progress' ? 'Destination' : 'Pickup'}</span>
        <span class="v" style="max-width:60%;text-align:right">${escapeHtml(target || '—')}</span></div>
      <div class="kv"><span class="k">Est. fare</span><span class="v">${money(r.estimate.total, cfg)}</span></div>
      <div class="kv"><span class="k">Your cut</span><span class="v" style="color:var(--ok)">${money(r.estimate.total*(1-cfg.billing.commissionRate), cfg)}</span></div>
    </div>
    <button class="${step.cls}" id="next">${step.action}</button>
    ${r.status === 'accepted' ? '<button class="ghost" id="cancel" style="margin-top:10px">Cancel</button>' : ''}
  `;
  document.getElementById('next').onclick = async () => {
    try {
      const { ride } = await api.post(`/api/rides/${r.id}/${step.next}`, { driverId: driver.id });
      currentRide = ride; renderTrip();
    } catch (err) { toast(err.message); }
  };
  const cancel = document.getElementById('cancel');
  if (cancel) cancel.onclick = async () => {
    await api.post(`/api/rides/${r.id}/cancel`, { by: 'driver' });
    currentRide = null; clearTripMarkers(); renderHome();
  };
}

function renderTripDone() {
  const f = currentRide.fare;
  sheet.innerHTML = `
    <div class="status"><span class="dot ok"></span>Ride complete</div>
    <div class="card">
      <div class="kv"><span class="k">Distance</span><span class="v">${f.distanceKm} km</span></div>
      <div class="kv"><span class="k">Fare collected</span><span class="v">${money(f.total, cfg)}</span></div>
      <div class="kv"><span class="k">Platform fee (${Math.round(f.commissionRate*100)}%)</span><span class="v" style="color:var(--muted)">−${money(f.platformCommission, cfg)}</span></div>
      <div class="kv total"><span class="k">You earned</span><span class="v">${money(f.driverPayout, cfg)}</span></div>
    </div>
    <button class="primary" id="back">Back online</button>
  `;
  document.getElementById('back').onclick = () => { currentRide = null; clearTripMarkers(); renderHome(); };
}

function clearTripMarkers() {
  for (const k of ['pickup', 'dropoff']) { if (markers[k]) { map.removeLayer(markers[k]); markers[k] = null; } }
}

// ─── Realtime ─────────────────────────────────────────────────────────────────

function handleEvent(msg) {
  switch (msg.event) {
    case 'identified':
      if (online) { statusBadge.textContent = 'online'; statusBadge.className = 'badge on'; }
      break;
    case 'ride_offer':
      if (currentRide) { api.post(`/api/rides/${msg.ride.id}/decline`, { driverId: driver.id }); break; }
      offer = msg; renderOffer();
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      break;
    case 'offer_expired':
      if (offer && offer.ride.id === msg.rideId) { offer = null; clearInterval(offerTimer); clearTripMarkers(); toast('Offer expired'); renderHome(); }
      break;
    case 'ride_assigned':
      currentRide = msg.ride; offer = null; renderTrip();
      break;
    case 'ride_completed':
      currentRide = msg.ride; renderTripDone();
      break;
    case 'ride_update':
      if (currentRide && msg.ride.id === currentRide.id) { currentRide = msg.ride; renderTrip(); }
      break;
  }
}

function isActive(d) {
  return d.subscription?.status === 'active' && d.subscription.activeUntil > Date.now();
}
function escapeHtml(s='') { return s.replace(/[&<>"']/g, (c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
