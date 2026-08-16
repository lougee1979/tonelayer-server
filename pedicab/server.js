// Pedicab rideshare platform — HTTP API + static web clients + realtime hub.
//
// An Uber-style app built specifically for pedicabs. Riders hail a nearby
// pedicab; drivers pay a monthly membership plus a per-ride commission to be
// on the platform. Works in any city — maps use OpenStreetMap, no API key.

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { config } from './lib/config.js';
import { isValidCoord } from './lib/geo.js';
import { estimateFare, splitFare } from './lib/fare.js';
import * as store from './lib/store.js';
import { attachRealtime } from './lib/realtime.js';
import * as dispatch from './lib/dispatch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ok = (res, data) => res.json({ ok: true, ...data });
const bad = (res, code, error) => res.status(code).json({ ok: false, error });

// ─── Health + public config ──────────────────────────────────────────────────

app.get('/api/health', (_req, res) => ok(res, { status: 'up', time: Date.now() }));

// Pricing/monetization surface the clients display to users.
app.get('/api/config', (_req, res) =>
  ok(res, {
    currency: config.currency,
    currencySymbol: config.currencySymbol,
    fare: config.fare,
    billing: {
      monthlyFee: config.billing.monthlyFee,
      commissionRate: config.billing.commissionRate,
      subscriptionDays: config.billing.subscriptionDays,
    },
  }));

// ─── Riders ──────────────────────────────────────────────────────────────────

app.post('/api/riders', (req, res) => {
  const { name, phone } = req.body || {};
  ok(res, { rider: store.createRider({ name, phone }) });
});

app.post('/api/fare/estimate', (req, res) => {
  const { pickup, dropoff } = req.body || {};
  if (!isValidCoord(pickup) || !isValidCoord(dropoff)) return bad(res, 400, 'Valid pickup and dropoff required');
  ok(res, { estimate: estimateFare(pickup, dropoff) });
});

app.post('/api/rides', (req, res) => {
  const { riderId, pickup, dropoff, pickupAddress, dropoffAddress } = req.body || {};
  if (!store.getRider(riderId)) return bad(res, 400, 'Unknown rider');
  if (!isValidCoord(pickup) || !isValidCoord(dropoff)) return bad(res, 400, 'Valid pickup and dropoff required');
  const ride = dispatch.requestRide({ riderId, pickup, dropoff, pickupAddress, dropoffAddress });
  ok(res, { ride });
});

app.get('/api/rides/:id', (req, res) => {
  const ride = store.getRide(req.params.id);
  if (!ride) return bad(res, 404, 'Ride not found');
  ok(res, { ride: dispatch.publicRide(ride) });
});

app.post('/api/rides/:id/cancel', (req, res) => {
  const by = (req.body && req.body.by) || 'rider';
  const result = dispatch.cancelRide({ rideId: req.params.id, by });
  if (result.error) return bad(res, 400, result.error);
  ok(res, result);
});

// Rider rates the driver after a completed ride.
app.post('/api/rides/:id/rate', (req, res) => {
  const { stars } = req.body || {};
  const ride = store.getRide(req.params.id);
  if (!ride || ride.status !== 'completed') return bad(res, 400, 'Ride not completed');
  if (!(stars >= 1 && stars <= 5)) return bad(res, 400, 'Stars must be 1–5');
  const driver = store.getDriver(ride.driverId);
  const avg = store.addRating(driver, stars);
  ok(res, { driverRatingAvg: avg });
});

// ─── Drivers ─────────────────────────────────────────────────────────────────

app.post('/api/drivers', (req, res) => {
  const { name, phone, cabName } = req.body || {};
  ok(res, { driver: store.createDriver({ name, phone, cabName }) });
});

app.get('/api/drivers/:id', (req, res) => {
  const d = store.getDriver(req.params.id);
  if (!d) return bad(res, 404, 'Driver not found');
  ok(res, { driver: d, subscriptionActive: store.isSubscriptionActive(d) });
});

// Pay (or renew) the monthly membership fee.
app.post('/api/drivers/:id/subscribe', (req, res) => {
  const d = store.getDriver(req.params.id);
  if (!d) return bad(res, 404, 'Driver not found');
  const receipt = store.chargeMonthlyFee(d);
  ok(res, { subscription: d.subscription, receipt });
});

// Go online / offline. Going online requires an active membership.
app.post('/api/drivers/:id/status', (req, res) => {
  const d = store.getDriver(req.params.id);
  if (!d) return bad(res, 404, 'Driver not found');
  const { status, location } = req.body || {};
  if (!['online', 'offline'].includes(status)) return bad(res, 400, 'status must be online|offline');
  if (status === 'online') {
    if (!store.isSubscriptionActive(d)) return bad(res, 402, 'Membership inactive — pay the monthly fee to go online');
    if (!isValidCoord(location)) return bad(res, 400, 'Location required to go online');
    d.location = location;
    d.status = 'online';
  } else {
    d.status = 'offline';
  }
  ok(res, { status: d.status });
});

app.post('/api/drivers/:id/location', (req, res) => {
  const { location } = req.body || {};
  if (!isValidCoord(location)) return bad(res, 400, 'Valid location required');
  const result = dispatch.updateDriverLocation({ driverId: req.params.id, location });
  if (result.error) return bad(res, 404, result.error);
  ok(res, result);
});

// Driver earnings + fee/commission breakdown.
app.get('/api/drivers/:id/earnings', (req, res) => {
  const d = store.getDriver(req.params.id);
  if (!d) return bad(res, 404, 'Driver not found');
  ok(res, { earnings: d.earnings, subscription: d.subscription, subscriptionActive: store.isSubscriptionActive(d) });
});

// ─── Trip actions (driver-driven) ────────────────────────────────────────────

app.post('/api/rides/:id/accept', (req, res) => {
  const r = dispatch.acceptRide({ driverId: req.body?.driverId, rideId: req.params.id });
  if (r.error) return bad(res, 409, r.error);
  ok(res, r);
});
app.post('/api/rides/:id/decline', (req, res) => {
  dispatch.declineRide({ driverId: req.body?.driverId, rideId: req.params.id });
  ok(res, {});
});
for (const [action, fn] of [['arrive', dispatch.driverArrived], ['start', dispatch.startRide], ['complete', dispatch.completeRide]]) {
  app.post(`/api/rides/:id/${action}`, (req, res) => {
    const r = fn({ driverId: req.body?.driverId, rideId: req.params.id });
    if (r.error) return bad(res, 409, r.error);
    ok(res, r);
  });
}

// ─── Platform economics summary ──────────────────────────────────────────────

app.get('/api/platform/summary', (_req, res) => {
  const drivers = store.allDrivers();
  const rides = store.allRides();
  const completed = rides.filter((r) => r.status === 'completed');
  const grossFares = completed.reduce((s, r) => s + (r.fare?.total || 0), 0);
  const commission = completed.reduce((s, r) => s + (r.fare?.platformCommission || 0), 0);
  const membershipRevenue = drivers.reduce((s, d) => s + d.earnings.feesPaid, 0);
  ok(res, {
    drivers: drivers.length,
    activeMembers: drivers.filter((d) => store.isSubscriptionActive(d)).length,
    rides: rides.length,
    completedRides: completed.length,
    grossFares: Math.round(grossFares * 100) / 100,
    platformCommission: Math.round(commission * 100) / 100,
    membershipRevenue: Math.round(membershipRevenue * 100) / 100,
    platformRevenue: Math.round((commission + membershipRevenue) * 100) / 100,
  });
});

// ─── Boot ────────────────────────────────────────────────────────────────────

const server = http.createServer(app);
attachRealtime(server);

server.listen(config.port, () => {
  console.log(`🚲  Pedicab rideshare server on http://localhost:${config.port}`);
  console.log(`    Rider app:  http://localhost:${config.port}/`);
  console.log(`    Driver app: http://localhost:${config.port}/driver.html`);
});

export { app, server };
