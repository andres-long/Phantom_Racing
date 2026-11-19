// Finds roads worth turning into tracks in a finished drive -- plain math,
// no app state, so it can be tested on its own (see trackTimer.ts for where
// the drives come from and where the suggestions go).
//
// Two kinds of suggestion:
//  - "repeat": a stretch of this drive you've also driven on earlier drives
//    (your commute, the road to the gym...) -- the longest such stretch;
//  - "fast": otherwise, your quickest kilometre or so of this drive.
// Either way, roads already covered by a track you can race are skipped.
import { haversine } from "./geo";
import type { LatLng } from "./geo";

export type DrivePoint = LatLng & { t: number; speedKmh?: number };

// A stored earlier drive: just where it went.
export type PastDrive = { at: number; points: LatLng[] };

export type TrackSuggestion = {
  reason: "repeat" | "fast";
  trace: DrivePoint[];
  distanceM: number;
  durationMs: number;
  maxSpeedKmh: number;
  // For "repeat": how many drives (this one included) went this way.
  timesDriven: number;
};

// On the same road: within this of an earlier drive / a track.
const MATCH_M = 40;
// Grid cell for the spatial lookup, in degrees (~55 m north-south).
const CELL_DEG = 0.0005;
// A suggested track is at least this long, and at most this long.
export const MIN_SUGGEST_M = 1000;
export const MAX_SUGGEST_M = 15000;
// "fast" stretches are this long, and only worth it above this average.
const FAST_STRETCH_M = 1000;
const FAST_MIN_KMH = 40;
// A stretch counts as already a track when this much of it is on one.
const COVERED_FRACTION = 0.6;
// Spacing kept for stored drives (keeps the history small).
export const HISTORY_SPACING_M = 30;
export const HISTORY_MAX_POINTS = 1500;

// Keep a point every `spacingM` (plus the last) -- for storage and lookups.
export function thinBySpacing<T extends LatLng>(points: T[], spacingM: number, maxPoints = Infinity): T[] {
  if (points.length === 0) return [];
  const out: T[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (haversine(out[out.length - 1], points[i]) >= spacingM) out.push(points[i]);
  }
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  if (out.length > maxPoints) {
    const stride = Math.ceil(out.length / maxPoints);
    const sampled = out.filter((_, i) => i % stride === 0);
    if (sampled[sampled.length - 1] !== last) sampled.push(last);
    return sampled;
  }
  return out;
}

// Extra points along long gaps (a track drawn from directions has few).
function densify(points: LatLng[], stepM: number): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const a = points[i - 1];
      const b = points[i];
      const d = haversine(a, b);
      const n = Math.floor(d / stepM);
      for (let k = 1; k < n; k++) {
        const f = k / n;
        out.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });
      }
    }
    out.push(points[i]);
  }
  return out;
}

function cellKey(lat: number, lng: number) {
  return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;
}

// Points bucketed by grid cell, each tagged with which line it came from.
class Grid {
  private cells = new Map<string, { p: LatLng; id: number }[]>();
  add(points: LatLng[], id: number) {
    for (const p of points) {
      const k = cellKey(p.lat, p.lng);
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push({ p, id });
    }
  }
  // Which lines pass within MATCH_M of p.
  near(p: LatLng): Set<number> {
    const ids = new Set<number>();
    const ci = Math.floor(p.lat / CELL_DEG);
    const cj = Math.floor(p.lng / CELL_DEG);
    // Longitude cells shrink away from the equator -- look wider there.
    const lngSpan = Math.min(6, Math.ceil(1 / Math.max(0.2, Math.cos((p.lat * Math.PI) / 180))));
    for (let di = -1; di <= 1; di++) {
      for (let dj = -lngSpan; dj <= lngSpan; dj++) {
        const list = this.cells.get(`${ci + di}:${cj + dj}`);
        if (!list) continue;
        for (const e of list) {
          if (!ids.has(e.id) && haversine(e.p, p) <= MATCH_M) ids.add(e.id);
        }
      }
    }
    return ids;
  }
}

function stats(trace: DrivePoint[]) {
  let distanceM = 0;
  let maxSpeedKmh = 0;
  for (let i = 0; i < trace.length; i++) {
    if (i > 0) distanceM += haversine(trace[i - 1], trace[i]);
    if ((trace[i].speedKmh ?? 0) > maxSpeedKmh) maxSpeedKmh = trace[i].speedKmh ?? 0;
  }
  const durationMs = trace.length > 1 ? trace[trace.length - 1].t - trace[0].t : 0;
  return { distanceM, durationMs, maxSpeedKmh };
}

function cumulative(points: LatLng[]) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  return cum;
}

// Trim a stretch to at most MAX_SUGGEST_M (keeping its start).
function capLength(trace: DrivePoint[]): DrivePoint[] {
  const cum = cumulative(trace);
  if (cum[cum.length - 1] <= MAX_SUGGEST_M) return trace;
  const end = cum.findIndex((d) => d > MAX_SUGGEST_M);
  return trace.slice(0, Math.max(2, end));
}

function coveredByTrack(stretch: DrivePoint[], trackGrid: Grid | null) {
  if (!trackGrid || stretch.length === 0) return false;
  const thin = thinBySpacing(stretch, 25);
  // Per track: how much of the stretch runs along it.
  const counts = new Map<number, number>();
  for (const p of thin) for (const id of trackGrid.near(p)) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const n of counts.values()) if (n / thin.length >= COVERED_FRACTION) return true;
  return false;
}

// Same road as a stretch dismissed before (both ends close)?
function matchesAny(stretch: DrivePoint[], ends: { start: LatLng; end: LatLng }[]) {
  const s = stretch[0];
  const e = stretch[stretch.length - 1];
  return ends.some(
    (d) =>
      (haversine(d.start, s) < 250 && haversine(d.end, e) < 250) ||
      (haversine(d.start, e) < 250 && haversine(d.end, s) < 250)
  );
}

export function suggestTrack(
  drive: DrivePoint[],
  history: PastDrive[],
  tracks: LatLng[][],
  dismissed: { start: LatLng; end: LatLng }[] = []
): TrackSuggestion | null {
  if (drive.length < 5) return null;
  const total = stats(drive);
  if (total.distanceM < MIN_SUGGEST_M) return null;

  let trackGrid: Grid | null = null;
  if (tracks.length > 0) {
    trackGrid = new Grid();
    tracks.forEach((t, i) => trackGrid!.add(densify(t, 20), i));
  }

  // ---- "repeat": longest run of consecutive points shared with earlier drives.
  if (history.length > 0) {
    const histGrid = new Grid();
    history.forEach((h, i) => histGrid.add(densify(h.points, 25), i));
    const near = drive.map((p) => histGrid.near(p));
    const cum = cumulative(drive);
    let best: { from: number; to: number; ids: Set<number> } | null = null;
    let i = 0;
    while (i < drive.length) {
      if (near[i].size === 0) {
        i++;
        continue;
      }
      // Extend while the same earlier drive(s) keep matching. Short GPS
      // gaps (up to 2 points) don't break a stretch.
      let ids = new Set(near[i]);
      let j = i;
      let misses = 0;
      while (j + 1 < drive.length) {
        const nextIds = new Set([...ids].filter((id) => near[j + 1].has(id)));
        if (nextIds.size > 0) {
          ids = nextIds;
          misses = 0;
          j++;
        } else if (misses < 2 && j + 2 < drive.length) {
          misses++;
          j++;
        } else break;
      }
      while (j > i && near[j].size === 0) j--;
      const len = cum[j] - cum[i];
      if (len >= MIN_SUGGEST_M && (!best || len > cum[best.to] - cum[best.from])) best = { from: i, to: j, ids };
      i = j + 1;
    }
    if (best) {
      const stretch = capLength(drive.slice(best.from, best.to + 1));
      if (!coveredByTrack(stretch, trackGrid) && !matchesAny(stretch, dismissed)) {
        // Every earlier drive that ran along most of it.
        const thin = thinBySpacing(stretch, 50);
        const counts = new Map<number, number>();
        for (const p of thin) {
          for (const id of near[drive.indexOf(p)] ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        let times = 1;
        for (const n of counts.values()) if (n / thin.length >= 0.7) times++;
        const s = stats(stretch);
        if (s.durationMs > 0) {
          return { reason: "repeat", trace: stretch, ...s, timesDriven: Math.max(2, times) };
        }
      }
    }
  }

  // ---- "fast": the quickest ~1 km of this drive (two-pointer window).
  const cum = cumulative(drive);
  let bestFast: { from: number; to: number; kmh: number } | null = null;
  let a = 0;
  for (let b = 1; b < drive.length; b++) {
    while (a < b && cum[b] - cum[a + 1] >= FAST_STRETCH_M) a++;
    const len = cum[b] - cum[a];
    if (len < FAST_STRETCH_M) continue;
    const ms = drive[b].t - drive[a].t;
    if (ms <= 0) continue;
    const kmh = len / 1000 / (ms / 3_600_000);
    if (!bestFast || kmh > bestFast.kmh) bestFast = { from: a, to: b, kmh };
  }
  if (bestFast && bestFast.kmh >= FAST_MIN_KMH) {
    const stretch = drive.slice(bestFast.from, bestFast.to + 1);
    if (!coveredByTrack(stretch, trackGrid) && !matchesAny(stretch, dismissed)) {
      const s = stats(stretch);
      return { reason: "fast", trace: stretch, ...s, timesDriven: 1 };
    }
  }
  return null;
}
