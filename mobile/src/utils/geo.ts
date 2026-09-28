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

/**
 * How far along a course you are now, given how far along you already were
 * (mirrors advanceAlongPolyline in server/geo.js). A plain nearest-point
 * projection breaks on any course that passes the same spot twice -- a loop,
 * whose start IS its finish, or a road driven out and back -- so only the
 * stretch from just behind to `aheadM` ahead of where you were is searched,
 * preferring the nearer-along of two equally close matches. Positions off
 * the course (more than ~150 m away) leave you where you were. Never goes
 * backwards.
 */
export function advanceAlongPolyline(
  points: LatLng[],
  cumDist: number[],
  p: LatLng,
  prevM: number,
  aheadM = 500
): { distanceAlongM: number; lateralDistanceM: number } {
  if (points.length < 2) return { distanceAlongM: prevM, lateralDistanceM: Infinity };
  let best: { along: number; lateral: number; score: number } | null = null;
  for (let i = 0; i < points.length - 1; i++) {
    if (cumDist[i + 1] < prevM - 30) continue;
    if (cumDist[i] > prevM + aheadM) break;
    const { distanceAlong, lateralDistanceM } = projectOntoSegment(points[i], points[i + 1], p);
    const along = cumDist[i] + distanceAlong;
    const score = lateralDistanceM + 0.05 * Math.max(0, along - prevM);
    if (!best || score < best.score) best = { along, lateral: lateralDistanceM, score };
  }
  if (!best || best.lateral > 150) {
    return { distanceAlongM: prevM, lateralDistanceM: best ? best.lateral : Infinity };
  }
  return { distanceAlongM: Math.max(prevM, best.along), lateralDistanceM: best.lateral };
}

/** Window ahead to search, given the time since the last fix (fixes can
 *  bunch up or pause -- a tunnel, a locked phone). */
export function aheadWindowM(gapMs: number): number {
  return Math.max(500, (Math.max(0, gapMs) / 1000) * 90);
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

/**
 * Projects a polyline into flat local-meter (x, y) coordinates relative to
 * its first point -- x = east/west, y = north/south. Good enough over the
 * length of a single race segment (a few km at most); not meant for
 * anything that needs to handle the poles or the antimeridian.
 */
export function toLocalXY(points: LatLng[]): { x: number; y: number }[] {
  if (points.length === 0) return [];
  const origin = points[0];
  const latRad = toRad(origin.lat);
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(latRad);
  return points.map((p) => ({
    x: (p.lng - origin.lng) * mPerDegLng,
    y: (p.lat - origin.lat) * mPerDegLat,
  }));
}

/**
 * Reduces a polyline to `samples` points evenly spaced by distance along
 * the route (not by raw GPS-sample density, which varies a lot). Used for
 * cheap track-shape previews so a 20-minute, several-thousand-point
 * recording doesn't turn into several thousand rendered line segments.
 */
export function resamplePolyline(points: LatLng[], samples: number): LatLng[] {
  if (points.length <= samples) return points;
  const cumDist = cumulativeDistances(points);
  const total = cumDist[cumDist.length - 1];
  if (total === 0) return [points[0]];
  const result: LatLng[] = [];
  for (let i = 0; i < samples; i++) {
    const d = (total * i) / (samples - 1);
    result.push(pointAtDistance(points, cumDist, d));
  }
  return result;
}

export function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const totalSeconds = abs / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1);
  // Long hauls (50-200 mile runs) read as h:mm:ss.
  if (minutes >= 60) {
    return `${sign}${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${seconds.padStart(4, "0")}`;
  }
  if (minutes > 0) return `${sign}${minutes}:${seconds.padStart(4, "0")}`;
  return `${sign}${seconds}s`;
}
