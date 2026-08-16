// Seed a running server with a few paid-up, online demo drivers so you can
// test the rider flow without opening several driver tabs.
//
//   node scripts/seed-demo.js [baseUrl] [lat] [lng]
//
// Defaults to http://localhost:4000 around Times Square, NYC. Pass your own
// lat/lng (e.g. your city center) to drop the demo pedicabs near you.

const base = process.argv[2] || 'http://localhost:4000';
const lat = parseFloat(process.argv[3] || '40.7580');
const lng = parseFloat(process.argv[4] || '-73.9855');

const post = async (p, body) => {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const d = await r.json();
  if (!r.ok || d.ok === false) throw new Error(`${p}: ${d.error || r.status}`);
  return d;
};

const cabs = [
  { name: 'Alex', cabName: 'Sunset Cycle Cab' },
  { name: 'Priya', cabName: 'City Pedal Co.' },
  { name: 'Marco', cabName: 'Boardwalk Trikes' },
];

// scatter drivers within ~400m of the center
const jitter = () => (Math.random() - 0.5) * 0.007;

const run = async () => {
  console.log(`Seeding demo drivers on ${base} near ${lat},${lng}`);
  for (const c of cabs) {
    const { driver } = await post('/api/drivers', c);
    await post(`/api/drivers/${driver.id}/subscribe`, {});
    const location = { lat: lat + jitter(), lng: lng + jitter() };
    await post(`/api/drivers/${driver.id}/status`, { status: 'online', location });
    console.log(`  🚲 ${c.cabName} (${c.name}) online at ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`);
  }
  console.log('\nDone. Open the rider app and request a ride near that location.');
};

run().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
