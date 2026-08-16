// Geospatial helpers. Coordinates are { lat, lng } in decimal degrees.

const EARTH_RADIUS_KM = 6371;

const toRad = (deg) => (deg * Math.PI) / 180;

// Great-circle distance between two points, in kilometres (haversine).
export function distanceKm(a, b) {
  if (!a || !b) return Infinity;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Rough estimated travel time in minutes at a given average speed (km/h).
export function etaMinutes(distanceKilometres, avgSpeedKmh) {
  if (!avgSpeedKmh) return 0;
  return (distanceKilometres / avgSpeedKmh) * 60;
}

// Basic validation for an incoming coordinate.
export function isValidCoord(c) {
  return (
    c &&
    typeof c.lat === 'number' &&
    typeof c.lng === 'number' &&
    c.lat >= -90 && c.lat <= 90 &&
    c.lng >= -180 && c.lng <= 180
  );
}
