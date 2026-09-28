import { api } from "./api/client";
import { SegmentSummary, SubmitRunResponse, LatLng } from "./types";
import { cumulativeDistances, haversine, advanceAlongPolyline, aheadWindowM } from "./utils/geo";

// Drive through any existing track and your time goes on its board -- no
// need to tap anything. Every screen that watches GPS feeds its fixes in
// here (feedTrackTimer, next to recordSpeed); this module keeps the tracks
// around you, notices when you roll through one's start moving, follows you
// along it, and when you reach the end submits the run exactly as a
// recorded one would be. It works silently: a small "Timing" tag while it's
// following you, and a result card at the finish (see TrackTimerToast).
//
// Module-level for the same reason as topSpeed.ts: several screens feed it
// and it has to keep its state across navigation between them.

// Within this of a track's start while moving, a timed attempt is armed.
const ARM_RADIUS_M = 45;
const ARM_MIN_SPEED_KMH = 8;
// An attempt is dropped once you're this far off the track for a few fixes,
// or you've made no headway along it for this long.
const OFF_TRACK_M = 200;
const OFF_TRACK_FIXES = 3;
const STALL_MS = 3 * 60 * 1000;
// The server only takes a run that ends within 60 m of the track's end.
const FINISH_SLACK_M = 40;
// Tracks are re-fetched this often, or once you've moved this far from
// where they were last fetched.
const REFRESH_MS = 10 * 60 * 1000;
const REFRESH_MOVE_M = 20000;
// Only tracks whose start is within this of you are checked for arming.
const NEARBY_M = 3000;
// Duplicate fixes (two screens feeding the same GPS) are dropped.
const MIN_FIX_GAP_MS = 300;

type Fix = { lat: number; lng: number; t: number; speedKmh: number };
type Track = SegmentSummary & { cumDist: number[] };
type Attempt = {
  track: Track;
  trace: { lat: number; lng: number; t: number }[];
  distanceM: number;
  maxSpeedKmh: number;
  offTrackFixes: number;
  lastHeadwayAt: number;
};

export type TrackTimerStatus =
  | { kind: "idle" }
  | { kind: "timing"; segmentId: string; segmentName: string; startedAt: number; progress: number }
  | { kind: "saving"; segmentName: string }
  | {
      kind: "result";
      segmentId: string;
      segmentName: string;
      result: SubmitRunResponse;
      at: number;
    };

let deviceId: string | null = null;
let tracks: Track[] = [];
let fetchedAt = 0;
let fetchedAtPos: LatLng | null = null;
let fetching = false;
let lastFixT = 0;
const attempts = new Map<string, Attempt>();
// Tracks being timed on purpose right now (RecordRun) -- not doubled up.
const suppressed = new Set<string>();
let status: TrackTimerStatus = { kind: "idle" };
const listeners = new Set<(s: TrackTimerStatus) => void>();

function setStatus(s: TrackTimerStatus) {
  status = s;
  listeners.forEach((l) => l(s));
}

export function getTrackTimerStatus() {
  return status;
}

export function subscribeTrackTimer(l: (s: TrackTimerStatus) => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function setTrackTimerUser(nextDeviceId: string | null) {
  if (nextDeviceId === deviceId) return;
  deviceId = nextDeviceId;
  attempts.clear();
  tracks = [];
  fetchedAt = 0;
  fetchedAtPos = null;
  setStatus({ kind: "idle" });
}

// RecordRun calls this while it's timing a track itself.
export function suppressTrackTimer(segmentId: string, on: boolean) {
  if (on) {
    suppressed.add(segmentId);
    attempts.delete(segmentId);
    publishTiming();
  } else {
    suppressed.delete(segmentId);
  }
}

// A newly created track should be timeable straight away.
export function refreshTrackTimerTracks() {
  fetchedAt = 0;
}

export function dismissTrackTimerResult() {
  if (status.kind === "result") publishTiming(true);
}

function maybeFetch(pos: LatLng) {
  if (!deviceId || fetching) return;
  const stale = Date.now() - fetchedAt > REFRESH_MS;
  const moved = fetchedAtPos ? haversine(fetchedAtPos, pos) > REFRESH_MOVE_M : true;
  if (!stale && !moved) return;
  fetching = true;
  const forDevice = deviceId;
  api
    .listSegments(forDevice)
    .then((list) => {
      if (deviceId !== forDevice) return;
      tracks = list
        .filter((s) => Array.isArray(s.points) && s.points.length >= 2 && s.lengthM > 50)
        .map((s) => ({ ...s, cumDist: cumulativeDistances(s.points) }));
      fetchedAt = Date.now();
      fetchedAtPos = pos;
    })
    .catch(() => {
      // Try again on a later fix (not every fix: back off a minute).
      fetchedAt = Date.now() - REFRESH_MS + 60000;
    })
    .finally(() => {
      fetching = false;
    });
}

// The attempt furthest along is the one the tag shows.
function publishTiming(force = false) {
  if (!force && (status.kind === "result" || status.kind === "saving")) return;
  let lead: Attempt | null = null;
  for (const a of attempts.values()) {
    // Not worth a tag until you're properly under way.
    if (a.distanceM < 30) continue;
    if (!lead || a.distanceM / a.track.lengthM > lead.distanceM / lead.track.lengthM) lead = a;
  }
  setStatus(
    lead
      ? {
          kind: "timing",
          segmentId: lead.track.id,
          segmentName: lead.track.name,
          startedAt: lead.trace[0].t,
          progress: Math.min(1, lead.distanceM / (lead.track.cumDist[lead.track.cumDist.length - 1] || 1)),
        }
      : { kind: "idle" }
  );
}

async function submit(a: Attempt) {
  if (!deviceId) return;
  const forDevice = deviceId;
  setStatus({ kind: "saving", segmentName: a.track.name });
  try {
    const result = await api.submitRun(a.track.id, forDevice, a.trace, a.maxSpeedKmh);
    if (deviceId !== forDevice) return;
    setStatus({ kind: "result", segmentId: a.track.id, segmentName: a.track.name, result, at: Date.now() });
  } catch {
    // Didn't validate (cut a corner, GPS gap...) -- silently not a time.
    publishTiming(true);
  }
}

// One GPS fix, from whichever screen is watching. Cheap enough per fix.
export function feedTrackTimer(fix: Fix) {
  if (!deviceId || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return;
  const t = fix.t || Date.now();
  if (t < lastFixT + MIN_FIX_GAP_MS) return;
  const gapMs = lastFixT ? t - lastFixT : 1000;
  lastFixT = t;
  const pos = { lat: fix.lat, lng: fix.lng };
  maybeFetch(pos);
  const point = { lat: fix.lat, lng: fix.lng, t };

  // Advance (or drop, or finish) everything under way.
  for (const [id, a] of attempts) {
    const length = a.track.cumDist[a.track.cumDist.length - 1];
    const before = a.distanceM;
    const { distanceAlongM, lateralDistanceM } = advanceAlongPolyline(
      a.track.points,
      a.track.cumDist,
      pos,
      a.distanceM,
      aheadWindowM(gapMs)
    );
    // Still sitting at (or rolling up to) the start: the clock starts from
    // the last fix before you leave it, like a start line.
    if (distanceAlongM < 5 && haversine(a.track.points[0], pos) < ARM_RADIUS_M) {
      a.trace = [point];
      a.distanceM = distanceAlongM;
      a.lastHeadwayAt = t;
      continue;
    }
    a.trace.push(point);
    if (fix.speedKmh > a.maxSpeedKmh) a.maxSpeedKmh = fix.speedKmh;
    a.offTrackFixes = lateralDistanceM > OFF_TRACK_M ? a.offTrackFixes + 1 : 0;
    a.distanceM = distanceAlongM;
    if (distanceAlongM > before + 5) a.lastHeadwayAt = t;
    if (a.offTrackFixes >= OFF_TRACK_FIXES || t - a.lastHeadwayAt > STALL_MS) {
      attempts.delete(id);
      continue;
    }
    const finishAt = length - Math.min(length * 0.02, FINISH_SLACK_M);
    if (a.distanceM >= finishAt && a.trace.length >= 3 && t - a.trace[0].t >= 3000) {
      attempts.delete(id);
      submit(a);
    }
  }

  // Arm any track whose start you're rolling through.
  if (fix.speedKmh >= ARM_MIN_SPEED_KMH) {
    for (const track of tracks) {
      if (attempts.has(track.id) || suppressed.has(track.id)) continue;
      const d = haversine(track.points[0], pos);
      if (d > NEARBY_M || d > ARM_RADIUS_M) continue;
      attempts.set(track.id, {
        track,
        trace: [point],
        distanceM: 0,
        maxSpeedKmh: fix.speedKmh,
        offTrackFixes: 0,
        lastHeadwayAt: t,
      });
    }
  }

  publishTiming();
}
