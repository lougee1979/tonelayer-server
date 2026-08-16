// In-memory data store. Deliberately swappable: every read/write goes through
// these functions, so replacing the Maps with a real database (Postgres,
// Redis, etc.) later means changing only this file.

import { config } from './config.js';

let _seq = 1;
export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${(_seq++).toString(36)}`;

const drivers = new Map(); // id -> driver
const riders = new Map();  // id -> rider
const rides = new Map();   // id -> ride

// ─── Riders ──────────────────────────────────────────────────────────────────

export function createRider({ name, phone }) {
  const id = newId('rider');
  const rider = { id, name: name || 'Guest', phone: phone || null, createdAt: Date.now(), ratingAvg: null, ratingCount: 0 };
  riders.set(id, rider);
  return rider;
}
export const getRider = (id) => riders.get(id) || null;

// ─── Drivers + subscription ──────────────────────────────────────────────────

export function createDriver({ name, phone, cabName }) {
  const id = newId('driver');
  const now = Date.now();
  const driver = {
    id,
    name: name || 'Driver',
    phone: phone || null,
    cabName: cabName || 'Pedicab',        // e.g. "Sunset Cycle Cab"
    createdAt: now,
    // Membership starts inactive until the driver pays the monthly fee.
    subscription: { status: 'inactive', activeUntil: null, lastPaymentAt: null },
    status: 'offline',                    // offline | online | on_trip
    location: null,                       // { lat, lng }
    ratingAvg: null,
    ratingCount: 0,
    // Lifetime earnings ledger.
    earnings: { grossFares: 0, platformCommission: 0, netPayout: 0, ridesCompleted: 0, feesPaid: 0 },
  };
  drivers.set(id, driver);
  return driver;
}
export const getDriver = (id) => drivers.get(id) || null;
export const allDrivers = () => [...drivers.values()];

// Charge (or renew) the monthly membership. In production this would call a
// payment processor (Stripe, etc.); here we record the successful charge.
export function chargeMonthlyFee(driver) {
  const now = Date.now();
  const base = driver.subscription.activeUntil && driver.subscription.activeUntil > now
    ? driver.subscription.activeUntil   // extend from current expiry if still active
    : now;
  driver.subscription.activeUntil = base + config.billing.subscriptionDays * 86400_000;
  driver.subscription.status = 'active';
  driver.subscription.lastPaymentAt = now;
  driver.earnings.feesPaid += config.billing.monthlyFee;
  return { charged: config.billing.monthlyFee, activeUntil: driver.subscription.activeUntil };
}

export function isSubscriptionActive(driver) {
  return driver.subscription.status === 'active' &&
    driver.subscription.activeUntil != null &&
    driver.subscription.activeUntil > Date.now();
}

// Record a completed ride's money against a driver's earnings ledger.
export function recordEarnings(driver, split) {
  driver.earnings.grossFares += split.total;
  driver.earnings.platformCommission += split.platformCommission;
  driver.earnings.netPayout += split.driverPayout;
  driver.earnings.ridesCompleted += 1;
}

// ─── Rides ───────────────────────────────────────────────────────────────────

export function createRide(ride) {
  const id = newId('ride');
  const full = { id, createdAt: Date.now(), ...ride };
  rides.set(id, full);
  return full;
}
export const getRide = (id) => rides.get(id) || null;
export const allRides = () => [...rides.values()];

// ─── Ratings ─────────────────────────────────────────────────────────────────

export function addRating(entity, stars) {
  const prevTotal = (entity.ratingAvg || 0) * entity.ratingCount;
  entity.ratingCount += 1;
  entity.ratingAvg = Math.round(((prevTotal + stars) / entity.ratingCount) * 100) / 100;
  return entity.ratingAvg;
}
