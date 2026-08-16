// Dispatch engine: the ride lifecycle state machine + nearest-driver matching.
//
// Ride status flow:
//   requested → offering → accepted → arrived → in_progress → completed
//   (or → cancelled at most points, or → no_drivers if nobody accepts)

import { config } from './config.js';
import { distanceKm, etaMinutes } from './geo.js';
import { estimateFare, priceRide, splitFare } from './fare.js';
import * as store from './store.js';
import { sendToDriver, sendToRider } from './realtime.js';

// rideId -> live offer state while we're shopping the ride around.
const offers = new Map();

function publicRide(ride) {
  const driver = ride.driverId ? store.getDriver(ride.driverId) : null;
  return {
    id: ride.id,
    status: ride.status,
    pickup: ride.pickup,
    dropoff: ride.dropoff,
    pickupAddress: ride.pickupAddress || null,
    dropoffAddress: ride.dropoffAddress || null,
    estimate: ride.estimate,
    fare: ride.fare || null,
    riderId: ride.riderId,
    driver: driver ? {
      id: driver.id, name: driver.name, cabName: driver.cabName,
      location: driver.location, ratingAvg: driver.ratingAvg,
    } : null,
    createdAt: ride.createdAt,
  };
}

// Drivers who can currently take a ride: online, paid-up, and not on a trip.
function availableDrivers() {
  return store.allDrivers().filter(
    (d) => d.status === 'online' && d.location && store.isSubscriptionActive(d),
  );
}

// ─── Request a ride ──────────────────────────────────────────────────────────

export function requestRide({ riderId, pickup, dropoff, pickupAddress, dropoffAddress }) {
  const estimate = estimateFare(pickup, dropoff);
  const ride = store.createRide({
    riderId, pickup, dropoff, pickupAddress, dropoffAddress,
    estimate, status: 'requested', driverId: null,
  });
  startOffering(ride);
  return publicRide(ride);
}

function startOffering(ride) {
  const candidates = availableDrivers()
    .map((d) => ({ driver: d, dist: distanceKm(d.location, ride.pickup) }))
    .filter((c) => c.dist <= config.matching.searchRadiusKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, config.matching.maxOfferAttempts)
    .map((c) => c.driver.id);

  offers.set(ride.id, { candidates, index: -1, timer: null, declined: new Set() });
  ride.status = 'offering';
  offerNext(ride);
}

function offerNext(ride) {
  const state = offers.get(ride.id);
  if (!state) return;
  state.index += 1;

  if (state.index >= state.candidates.length) {
    // Ran out of drivers to ask.
    ride.status = 'no_drivers';
    offers.delete(ride.id);
    sendToRider(ride.riderId, 'ride_update', { ride: publicRide(ride) });
    return;
  }

  const driverId = state.candidates[state.index];
  const driver = store.getDriver(driverId);
  // Skip drivers who went offline / got busy since we built the list.
  if (!driver || driver.status !== 'online' || !store.isSubscriptionActive(driver)) {
    return offerNext(ride);
  }

  state.offeredTo = driverId;
  const pickupDist = distanceKm(driver.location, ride.pickup);
  sendToDriver(driverId, 'ride_offer', {
    ride: publicRide(ride),
    pickupDistanceKm: Math.round(pickupDist * 100) / 100,
    pickupEtaMin: Math.round(etaMinutes(pickupDist, config.fare.avgSpeedKmh)),
    expiresInMs: config.matching.offerTimeoutMs,
  });

  state.timer = setTimeout(() => {
    // Driver didn't respond in time — move on.
    if (offers.get(ride.id)?.offeredTo === driverId && ride.status === 'offering') {
      sendToDriver(driverId, 'offer_expired', { rideId: ride.id });
      offerNext(ride);
    }
  }, config.matching.offerTimeoutMs);
}

// ─── Driver responses ────────────────────────────────────────────────────────

export function acceptRide({ driverId, rideId }) {
  const ride = store.getRide(rideId);
  const state = offers.get(rideId);
  if (!ride || ride.status !== 'offering') return { error: 'Ride is no longer available' };
  if (!state || state.offeredTo !== driverId) return { error: 'This offer is no longer valid' };

  const driver = store.getDriver(driverId);
  if (!driver || !store.isSubscriptionActive(driver)) return { error: 'Driver not eligible' };

  clearTimeout(state.timer);
  offers.delete(rideId);

  ride.driverId = driverId;
  ride.status = 'accepted';
  ride.acceptedAt = Date.now();
  driver.status = 'on_trip';

  const pub = publicRide(ride);
  sendToRider(ride.riderId, 'ride_update', { ride: pub });
  sendToDriver(driverId, 'ride_assigned', { ride: pub });
  return { ride: pub };
}

export function declineRide({ driverId, rideId }) {
  const ride = store.getRide(rideId);
  const state = offers.get(rideId);
  if (!ride || !state || state.offeredTo !== driverId) return { ok: false };
  clearTimeout(state.timer);
  state.declined.add(driverId);
  offerNext(ride);
  return { ok: true };
}

// ─── Trip progression ────────────────────────────────────────────────────────

function requireDriverOnRide(rideId, driverId) {
  const ride = store.getRide(rideId);
  if (!ride) return { error: 'Ride not found' };
  if (ride.driverId !== driverId) return { error: 'Not your ride' };
  return { ride };
}

export function driverArrived({ driverId, rideId }) {
  const { ride, error } = requireDriverOnRide(rideId, driverId);
  if (error) return { error };
  if (ride.status !== 'accepted') return { error: 'Ride not in a state to mark arrived' };
  ride.status = 'arrived';
  ride.arrivedAt = Date.now();
  const pub = publicRide(ride);
  sendToRider(ride.riderId, 'ride_update', { ride: pub });
  return { ride: pub };
}

export function startRide({ driverId, rideId }) {
  const { ride, error } = requireDriverOnRide(rideId, driverId);
  if (error) return { error };
  if (ride.status !== 'arrived') return { error: 'Rider not picked up yet' };
  ride.status = 'in_progress';
  ride.startedAt = Date.now();
  const pub = publicRide(ride);
  sendToRider(ride.riderId, 'ride_update', { ride: pub });
  return { ride: pub };
}

export function completeRide({ driverId, rideId }) {
  const { ride, error } = requireDriverOnRide(rideId, driverId);
  if (error) return { error };
  if (ride.status !== 'in_progress') return { error: 'Ride is not in progress' };

  // Final fare from actual distance + actual elapsed ride time.
  const km = distanceKm(ride.pickup, ride.dropoff);
  const minutes = ride.startedAt ? (Date.now() - ride.startedAt) / 60000 : etaMinutes(km, config.fare.avgSpeedKmh);
  const fare = priceRide(km, Math.max(minutes, 1));
  const split = splitFare(fare.total);

  ride.status = 'completed';
  ride.completedAt = Date.now();
  ride.fare = { ...fare, ...split };

  const driver = store.getDriver(driverId);
  driver.status = 'online';
  store.recordEarnings(driver, split);

  const pub = publicRide(ride);
  sendToRider(ride.riderId, 'ride_update', { ride: pub });
  sendToDriver(driverId, 'ride_completed', { ride: pub, split });
  return { ride: pub, split };
}

export function cancelRide({ rideId, by }) {
  const ride = store.getRide(rideId);
  if (!ride) return { error: 'Ride not found' };
  if (['completed', 'cancelled'].includes(ride.status)) return { error: 'Ride already finished' };

  const state = offers.get(rideId);
  if (state) { clearTimeout(state.timer); offers.delete(rideId); }

  const priorDriver = ride.driverId ? store.getDriver(ride.driverId) : null;
  ride.status = 'cancelled';
  ride.cancelledAt = Date.now();
  ride.cancelledBy = by;
  if (priorDriver && priorDriver.status === 'on_trip') priorDriver.status = 'online';

  const pub = publicRide(ride);
  if (by !== 'rider') sendToRider(ride.riderId, 'ride_update', { ride: pub });
  if (ride.driverId && by !== 'driver') sendToDriver(ride.driverId, 'ride_update', { ride: pub });
  return { ride: pub };
}

// ─── Live driver location relay ──────────────────────────────────────────────

export function updateDriverLocation({ driverId, location }) {
  const driver = store.getDriver(driverId);
  if (!driver) return { error: 'Driver not found' };
  driver.location = location;

  // If this driver is on an active ride, stream their position to the rider.
  const active = store.allRides().find(
    (r) => r.driverId === driverId && ['accepted', 'arrived', 'in_progress'].includes(r.status),
  );
  if (active) sendToRider(active.riderId, 'driver_location', { rideId: active.id, location });
  return { ok: true };
}

export { publicRide };
