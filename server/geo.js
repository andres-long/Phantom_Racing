// Shared geo math for segment-based ("ghost") racing.
// No external dependencies on purpose (see README for why).

const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two {lat,lng} points, in meters. */
function haversine(a, b) {
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

/** Cumulative distance (meters) at each point of a polyline, starting at 0. */
function cumulativeDistances(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  }
  return cum;
}

/** Total length of a polyline in meters. */
function polylineLength(points) {
  if (points.length < 2) return 0;
  return cumulativeDistances(points)[points.length - 1];
}

/**
 * Projects point p onto line segment [a,b] (treated as locally flat, fine
 * for the short segment lengths involved here) and returns:
 *   - distanceAlong: distance in meters from a to the projected point
 *   - lateralDistanceM: perpendicular distance from p to the segment (approx, meters)
 *   - segmentLengthM: length of [a,b]
 */
function projectOntoSegment(a, b, p) {
  // Convert to a local equirectangular approximation centered on `a` so we
  // can do simple 2D vector math (good enough at street/highway scale).
  const latRad = toRad(a.lat);
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(latRad);

  const toXY = (pt) => ({
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

  return {
    distanceAlong: t * segmentLengthM,
    lateralDistanceM,
    segmentLengthM,
  };
}

/**
 * Projects a live point onto a whole polyline (map-matching, simplified).
 * Returns the best (closest) match: cumulative distance from the polyline
 * start, and how far off the road the point is (meters).
 */
function projectOntoPolyline(points, cumDist, p) {
  if (points.length < 2) {
    return { distanceAlongM: 0, lateralDistanceM: Infinity };
  }
  let best = null;
  for (let i = 0; i < points.length - 1; i++) {
    const { distanceAlong, lateralDistanceM } = projectOntoSegment(
      points[i],
      points[i + 1],
      p
    );
    const totalDistanceAlong = cumDist[i] + distanceAlong;
    if (!best || lateralDistanceM < best.lateralDistanceM) {
      best = { distanceAlongM: totalDistanceAlong, lateralDistanceM };
    }
  }
  return best;
}

/**
 * Converts a raw GPS trace (array of {lat,lng,t}) for a completed run into a
 * "ghost profile": a monotonic array of {distanceAlongM, elapsedMs} sampled
 * against the segment's own polyline. This is what lets us answer "how far
 * along was the ghost when it had been driving for X ms" (or the inverse)
 * during someone else's live run.
 */
function buildGhostProfile(segmentPoints, segmentCumDist, trace) {
  if (trace.length === 0) return [];
  const t0 = trace[0].t;
  const profile = [];
  let lastDistance = -Infinity;
  for (const pt of trace) {
    const { distanceAlongM } = projectOntoPolyline(
      segmentPoints,
      segmentCumDist,
      pt
    );
    // Keep it monotonic (GPS jitter can otherwise make you "go backwards").
    const distance = Math.max(distanceAlongM, lastDistance);
    lastDistance = distance;
    profile.push({ distanceAlongM: distance, elapsedMs: pt.t - t0 });
  }
  return profile;
}

/**
 * Given a ghost profile and a distance-along value, interpolates the
 * elapsed time the ghost had at that distance. Used to compute the live
 * "ahead/behind" delta while racing.
 */
function ghostElapsedAtDistance(ghostProfile, distanceAlongM) {
  if (ghostProfile.length === 0) return null;
  if (distanceAlongM <= ghostProfile[0].distanceAlongM) {
    return ghostProfile[0].elapsedMs;
  }
  const lastPoint = ghostProfile[ghostProfile.length - 1];
  if (distanceAlongM >= lastPoint.distanceAlongM) {
    return lastPoint.elapsedMs;
  }
  for (let i = 1; i < ghostProfile.length; i++) {
    const prev = ghostProfile[i - 1];
    const curr = ghostProfile[i];
    if (distanceAlongM <= curr.distanceAlongM) {
      const span = curr.distanceAlongM - prev.distanceAlongM;
      const frac = span === 0 ? 0 : (distanceAlongM - prev.distanceAlongM) / span;
      return prev.elapsedMs + frac * (curr.elapsedMs - prev.elapsedMs);
    }
  }
  return lastPoint.elapsedMs;
}

/** How close (meters) a run's start/end must be to the segment's to count. */
const START_END_TOLERANCE_M = 60;

/**
 * Sanity-checks that a submitted run's GPS trace actually covers the
 * segment (starts near the segment start, ends near the segment end, and
 * covers at least ~90% of the segment length) so leaderboard times can't be
 * gamed by submitting a short/irrelevant trace.
 */
function validateRunAgainstSegment(segmentPoints, segmentCumDist, trace) {
  if (trace.length < 2) {
    return { valid: false, reason: "Run trace too short." };
  }
  const segStart = segmentPoints[0];
  const segEnd = segmentPoints[segmentPoints.length - 1];
  const runStart = trace[0];
  const runEnd = trace[trace.length - 1];

  const startGap = haversine(segStart, runStart);
  const endGap = haversine(segEnd, runEnd);

  if (startGap > START_END_TOLERANCE_M) {
    return {
      valid: false,
      reason: `Run doesn't start near the segment start (${Math.round(
        startGap
      )}m away).`,
    };
  }
  if (endGap > START_END_TOLERANCE_M) {
    return {
      valid: false,
      reason: `Run doesn't end near the segment end (${Math.round(
        endGap
      )}m away).`,
    };
  }

  const profile = buildGhostProfile(segmentPoints, segmentCumDist, trace);
  const coveredM = profile[profile.length - 1].distanceAlongM;
  const segmentLengthM = segmentCumDist[segmentCumDist.length - 1];
  if (coveredM < segmentLengthM * 0.9) {
    return {
      valid: false,
      reason: "Run doesn't cover enough of the segment.",
    };
  }

  return { valid: true, profile };
}

module.exports = {
  haversine,
  cumulativeDistances,
  polylineLength,
  projectOntoPolyline,
  buildGhostProfile,
  ghostElapsedAtDistance,
  validateRunAgainstSegment,
};
