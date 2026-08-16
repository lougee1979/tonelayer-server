# PediGo — Pedicab Rideshare 🚲

An Uber-style rideshare app built **specifically for pedicabs**. Riders hail a
nearby pedicab, see the fare up front, and track it live on a map. Drivers
register, pay a **monthly membership**, and keep most of every fare — the
platform takes a **small per-ride commission**.

Works in **any city**: maps use OpenStreetMap tiles and Nominatim geocoding, so
there is no Google Maps key or per-city setup.

This app is fully self-contained in the `pedicab/` directory and is independent
of the rest of this repository.

## Run it

```bash
cd pedicab
npm install
npm start          # http://localhost:4000
```

- **Rider app:** http://localhost:4000/
- **Driver app:** http://localhost:4000/driver.html
- **Platform economics:** http://localhost:4000/platform.html

### Try it without juggling tabs

Seed a few paid-up, online demo pedicabs near a location, then open the rider
app and request a ride:

```bash
npm run seed                         # near Times Square, NYC
node scripts/seed-demo.js http://localhost:4000 <lat> <lng>   # near you
```

## How it works

### Rider flow
Sign in → set pickup + destination (search an address or tap the map) → see the
fare estimate → request a pedicab → watch the driver approach in real time →
pay → rate the driver.

### Driver flow
Register your pedicab → **pay the monthly membership** → **go online** →
receive nearby ride offers with a countdown → accept → *arrived → start trip →
complete* → see your payout after the platform fee.

Going online is gated on an active membership; each completed ride is split
between the driver's payout and the platform's commission, and both are tracked
in the driver's earnings ledger.

### Monetization (both configurable in `lib/config.js`)
| Source | Default |
| --- | --- |
| Driver membership | **$49 / 30 days** |
| Platform commission per ride | **15% of the fare** |

The `GET /api/platform/summary` endpoint (and `/platform.html`) reports combined
revenue from commissions + memberships.

### Pedicab-tuned fares
Short-haul and slow by design: base fare + per-km + per-minute, with a minimum
fare floor and ETAs computed at a pedicab average speed (~12 km/h). All values
live in `lib/config.js` so a new market is a one-file retune.

## Architecture

```
pedicab/
├── server.js            Express REST API + static clients + realtime hub
├── lib/
│   ├── config.js        Fares, commission, membership, matching — all tunables
│   ├── geo.js           Haversine distance + ETA
│   ├── fare.js          Fare estimate, final pricing, commission split
│   ├── store.js         In-memory data store (swap for a DB in one file)
│   ├── realtime.js      WebSocket registry + push helpers (/ws)
│   └── dispatch.js      Ride lifecycle state machine + nearest-driver matching
├── public/              Mobile-first web clients (Leaflet + OpenStreetMap)
│   ├── index.html       Landing / role picker
│   ├── rider.html/.js   Rider app
│   ├── driver.html/.js  Driver app
│   └── platform.html    Platform economics dashboard
└── scripts/seed-demo.js Spin up demo drivers for local testing
```

Real time is over WebSockets: drivers and riders `identify` on connect, and the
server pushes ride offers, status changes, and live driver location to the right
party. The data store is in-memory and deliberately behind a single module
(`lib/store.js`), so swapping in Postgres/Redis later is a localized change.

### Ride lifecycle
```
requested → offering → accepted → arrived → in_progress → completed
                    ↘ no_drivers        ↘ cancelled (rider or driver)
```

## HTTP API (selected)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`  | `/api/config` | Public pricing + fee config |
| `POST` | `/api/riders` | Create a rider |
| `POST` | `/api/fare/estimate` | Fare estimate for pickup → dropoff |
| `POST` | `/api/rides` | Request a ride (starts matching) |
| `GET`  | `/api/rides/:id` | Ride status |
| `POST` | `/api/rides/:id/cancel` · `/rate` | Cancel / rate |
| `POST` | `/api/drivers` | Register a driver |
| `POST` | `/api/drivers/:id/subscribe` | Pay/renew monthly membership |
| `POST` | `/api/drivers/:id/status` | Go online/offline (online needs membership) |
| `POST` | `/api/drivers/:id/location` | Push live location |
| `GET`  | `/api/drivers/:id/earnings` | Earnings + fee/commission breakdown |
| `POST` | `/api/rides/:id/accept · decline · arrive · start · complete` | Trip actions |
| `GET`  | `/api/platform/summary` | Commission + membership revenue |

## Notes & next steps
- The demo uses lightweight name-only identity and an in-memory store (state
  resets on restart) so it's easy to try. Production would add real auth,
  a database, and a payment processor (e.g. Stripe) behind the `subscribe`
  and `complete` endpoints — the code isolates those seams on purpose.
- Nominatim geocoding is rate-limited for demo/light use; a production
  deployment should use a hosted geocoder.
