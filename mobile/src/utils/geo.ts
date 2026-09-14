// Client-side mirror of server/geo.js. Kept as plain, dependency-free math
// (no turf.js etc.) so the app has zero extra install surface for something
// this simple, and so the "am I ahead or behind the ghost" calc can run
// locally at GPS-update frequency without a network round trip.

export type LatLng = { lat: number; lng: number };
export type TracePoint = LatLng & { t: number }; // t = ms since epoch
export type GhostSample = { distanceAlongM: number; elapsedMs: number };

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

export function haversine(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_M * c;
}

export function cumulativeDistances(points: LatLng[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  }
  return cum;
}

export function polylineLength(points: LatLng[]): number {
  if (points.length < 2) return 0;
  return cumulativeDistances(points)[points.length - 1];
}

function projectOntoSegment(a: LatLng, b: LatLng, p: LatLng) {
  const latRad = toRad(a.lat);
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(latRad);

  const toXY = (pt: LatLng) => ({
    x: (pt.lng - a.lng) * mPerDegLng,
    y: (pt.lat - a.lat) * mPerDegLat,
  });

  const A = { x: 0, y: 0 };
  const B = toXY(b);
  const P = toXY(p);

  const ABx = B.x - A.x;
  const ABy = B.y - A.y;
  const segLenSq = ABx * ABx + ABy * ABy;

  let t = segLenSq === 0 ? 0 : ((P.x - A.x) * ABx + (P.y - A.y) * ABy) / segLenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = A.x + t * ABx;
  const projY = A.y + t * ABy;
  const dx = P.x - projX;
  const dy = P.y - projY;
  const lateralDistanceM = Math.sqrt(dx * dx + dy * dy);
  const segmentLengthM = Math.sqrt(segLenSq);

  return { distanceAlong: t * segmentLengthM, lateralDistanceM, segmentLengthM };
}

export function projectOntoPolyline(points: LatLng[], cumDist: number[], p: LatLng) {
  if (points.length < 2) return { distanceAlongM: 0, lateralDistanceM: Infinity };
  let best: { distanceAlongM: number; lateralDistanceM: number } | null = null;
  for (let i = 0; i < points.length - 1; i++) {
    const { distanceAlong, lateralDistanceM } = projectOntoSegment(points[i], points[i + 1], p);
    const totalDistanceAlong = cumDist[i] + distanceAlong;
    if (!best || lateralDistanceM < best.lateralDistanceM) {
      best = { distanceAlongM: totalDistanceAlong, lateralDistanceM };
    }
  }
  return best!;
}

/** Elapsed time (ms) the ghost had reached at a given distance along the segment. */
export function ghostElapsedAtDistance(profile: GhostSample[], distanceAlongM: number): number | null {
  if (profile.length === 0) return null;
  if (distanceAlongM <= profile[0].distanceAlongM) return profile[0].elapsedMs;
  const last = profile[profile.length - 1];
  if (distanceAlongM >= last.distanceAlongM) return last.elapsedMs;

  for (let i = 1; i < profile.length; i++) {
    const prev = profile[i - 1];
    const curr = profile[i];
    if (distanceAlongM <= curr.distanceAlongM) {
      const span = curr.distanceAlongM - prev.distanceAlongM;
      const frac = span === 0 ? 0 : (distanceAlongM - prev.distanceAlongM) / span;
      return prev.elapsedMs + frac * (curr.elapsedMs - prev.elapsedMs);
    }
  }
  return last.elapsedMs;
}

/** Interpolates the {lat,lng} at a given cumulative distance along a polyline. */
export function pointAtDistance(points: LatLng[], cumDist: number[], distanceAlongM: number): LatLng {
  if (points.length === 0) return { lat: 0, lng: 0 };
  if (points.length === 1 || distanceAlongM <= 0) return points[0];
  const total = cumDist[cumDist.length - 1];
  if (distanceAlongM >= total) return points[points.length - 1];

  for (let i = 1; i < cumDist.length; i++) {
    if (distanceAlongM <= cumDist[i]) {
      const span = cumDist[i] - cumDist[i - 1];
      const frac = span === 0 ? 0 : (distanceAlongM - cumDist[i - 1]) / span;
      return {
        lat: points[i - 1].lat + frac * (points[i].lat - points[i - 1].lat),
        lng: points[i - 1].lng + frac * (points[i].lng - points[i - 1].lng),
      };
    }
  }
  return points[points.length - 1];
}

/**
 * Given a ghost profile (distance -> elapsed samples), finds the distance
 * the ghost had reached at a given elapsed time (inverse of
 * ghostElapsedAtDistance) -- used to place the ghost marker on the map.
 */
export function distanceAtElapsed(profile: GhostSample[], elapsedMs: number): number {
  if (profile.length === 0) return 0;
  if (elapsedMs <= profile[0].elapsedMs) return profile[0].distanceAlongM;
  const last = profile[profile.length - 1];
  if (elapsedMs >= last.elapsedMs) return last.distanceAlongM;

  for (let i = 1; i < profile.length; i++) {
    const prev = profile[i - 1];
    const curr = profile[i];
    if (elapsedMs <= curr.elapsedMs) {
      const span = curr.elapsedMs - prev.elapsedMs;
      const frac = span === 0 ? 0 : (elapsedMs - prev.elapsedMs) / span;
      return prev.distanceAlongM + frac * (curr.distanceAlongM - prev.distanceAlongM);
    }
  }
  return last.distanceAlongM;
}

export function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const totalSeconds = abs / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1);
  if (minutes > 0) return `${sign}${minutes}:${seconds.padStart(4, "0")}`;
  return `${sign}${seconds}s`;
}
