// Fare + commission math. Kept separate from the store so pricing is easy to
// unit-test and retune per market.

import { config } from './config.js';
import { distanceKm, etaMinutes } from './geo.js';

const round2 = (n) => Math.round(n * 100) / 100;

// Estimate a fare from pickup → dropoff before a ride happens. Time cost is
// based on the expected duration at average pedicab speed.
export function estimateFare(pickup, dropoff) {
  const km = distanceKm(pickup, dropoff);
  const minutes = etaMinutes(km, config.fare.avgSpeedKmh);
  return priceRide(km, minutes);
}

// Final fare from the actual distance travelled and actual ride duration.
export function priceRide(km, minutes) {
  const { baseFare, perKm, perMinute, minimumFare } = config.fare;
  const raw = baseFare + perKm * km + perMinute * minutes;
  const total = Math.max(raw, minimumFare);
  return {
    distanceKm: round2(km),
    durationMin: round2(minutes),
    baseFare: round2(baseFare),
    distanceCost: round2(perKm * km),
    timeCost: round2(perMinute * minutes),
    total: round2(total),
    currency: config.currency,
  };
}

// Split a completed fare between the platform (commission) and the driver.
export function splitFare(total) {
  const commission = round2(total * config.billing.commissionRate);
  return {
    total: round2(total),
    commissionRate: config.billing.commissionRate,
    platformCommission: commission,
    driverPayout: round2(total - commission),
  };
}
