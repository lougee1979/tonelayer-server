// Central configuration for the pedicab rideshare platform.
// Everything money- or city-related lives here so the app is easy to retune
// for a new market without hunting through the code.

export const config = {
  // ─── Fare model (tuned for pedicabs, not cars) ────────────────────────────
  // Pedicabs are short-haul, slow, and priced closer to a premium novelty ride
  // than a taxi. Fares are distance + time based with a booking fee floor.
  currency: 'USD',
  currencySymbol: '$',
  fare: {
    baseFare: 5.00,        // flag-drop / booking fee
    perKm: 3.50,           // per kilometre travelled
    perMinute: 0.60,       // per minute of ride time
    minimumFare: 8.00,     // no ride costs less than this
    // Average pedicab speed used for ETA + time-cost estimates (km/h).
    avgSpeedKmh: 12,
  },

  // ─── Platform monetization ────────────────────────────────────────────────
  // Drivers pay to be on the platform two ways:
  //   1. A recurring monthly membership fee.
  //   2. A commission taken from every completed ride's fare.
  billing: {
    monthlyFee: 49.00,             // driver membership, charged every 30 days
    commissionRate: 0.15,          // platform's cut of each fare (15%)
    subscriptionDays: 30,          // membership period length
  },

  // ─── Matching ─────────────────────────────────────────────────────────────
  matching: {
    searchRadiusKm: 3.0,           // how far out to look for available drivers
    offerTimeoutMs: 20000,         // how long a driver has to accept an offer
    maxOfferAttempts: 8,           // how many drivers to try before giving up
  },

  // ─── Server ───────────────────────────────────────────────────────────────
  port: process.env.PORT || 4000,
};
