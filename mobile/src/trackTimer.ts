import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "./api/client";
import { SegmentSummary, SubmitRunResponse, LatLng } from "./types";
import { cumulativeDistances, haversine, advanceAlongPolyline, aheadWindowM } from "./utils/geo";
import { suggestTrack, thinBySpacing, HISTORY_SPACING_M, HISTORY_MAX_POINTS, MIN_SUGGEST_M } from "./utils/driveAnalysis";
import type { DrivePoint, PastDrive } from "./utils/driveAnalysis";

// Drive through any existing track and your time goes on its board -- no
// need to tap anything. Every screen that watches GPS feeds its fixes in
// here (feedTrackTimer, next to recordSpeed); this module keeps the tracks
// around you, notices when you roll through one's start moving, follows you
// along it, and when you reach the end submits the run exactly as a
// recorded one would be. It works silently: a small "Timing" tag while it's
// following you, and a result card at the finish (see TrackTimerToast).
//
// It also:
//  - times tracks driven backwards (end to start) and offers to save that
//    direction as a track of its own, with your drive as its first time;
//  - keeps timing lap after lap on a loop track;
//  - keeps a list of every track timed on this drive, shown as a summary
//    when you park;
//  - suggests new tracks from your drives: a road you keep driving, or
//    otherwise your quickest stretch of the drive (see driveAnalysis.ts).
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
// Start and end this close: a loop (timed lap after lap).
const LOOP_CLOSE_M = 60;
// A track already exists in the other direction if its ends are this close
// to this one's ends (the other way round).
const REVERSE_MATCH_M = 80;
// A drive ends after this long parked, or a gap this long between fixes.
const PARKED_MS = 4 * 60 * 1000;
const DRIVE_GAP_MS = 10 * 60 * 1000;
const MOVING_KMH = 10;
// Kept for suggestions: a point every 15 m, up to ~90 km.
const DRIVE_SPACING_M = 15;
const DRIVE_MAX_POINTS = 6000;
// Earlier drives remembered (per account, on the phone only).
const HISTORY_DRIVES = 20;
// A "quickest stretch" suggestion at most once a day (a road you keep
// driving can come up any time).
const FAST_SUGGEST_GAP_MS = 24 * 3600 * 1000;

type Fix = { lat: number; lng: number; t: number; speedKmh: number };
type Track = SegmentSummary & {
  cumDist: number[];
  // Set on the backwards copy of a track: the real track's id.
  reverseOf?: string;
  isLoop: boolean;
};
type Attempt = {
  track: Track;
  trace: { lat: number; lng: number; t: number }[];
  distanceM: number;
  maxSpeedKmh: number;
  offTrackFixes: number;
  lastHeadwayAt: number;
  lap: number;
  // Road actually driven since the start line (guards against a loop's
  // start and finish being the same place).
  travelledM: number;
};

// A new track the timer thinks you might want.
export type TrackSuggestionCard = {
  reason: "repeat" | "fast" | "reverse";
  name: string;
  trace: { lat: number; lng: number; t: number }[];
  distanceM: number;
  durationMs: number;
  maxSpeedKmh: number;
  timesDriven: number;
  // For "reverse": the track you drove backwards.
  reverseOfName?: string;
};

// One track timed on the current drive.
export type DriveLogEntry = {
  segmentId: string;
  segmentName: string;
  durationMs: number;
  rank: number;
  totalRuns: number;
  isNewRecord: boolean;
  lap: number;
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
      lap: number;
      // How many tracks this drive has timed so far, this one included.
      driveCount: number;
    }
  | { kind: "suggest"; suggestion: TrackSuggestionCard }
  | { kind: "saved"; segmentId: string; segmentName: string; result: SubmitRunResponse | null }
  | { kind: "summary"; entries: DriveLogEntry[] };

// Cards (as opposed to the small timing tag) stay up until dismissed or
// timed out, and queue up behind each other.
function isCard(s: TrackTimerStatus) {
  return s.kind === "result" || s.kind === "suggest" || s.kind === "saved" || s.kind === "summary";
}

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
const cardQueue: TrackTimerStatus[] = [];

// This drive: where it's gone (thinned) and the tracks it timed.
let drive: DrivePoint[] = [];
let driveLog: DriveLogEntry[] = [];
let lastMovingAt = 0;
let endingDrive = false;
// Backwards tracks already offered on this drive (not every lap).
const reverseOffered = new Set<string>();
// Cards saved for the end of the drive.
let heldCards: TrackTimerStatus[] = [];

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
  drive = [];
  driveLog = [];
  reverseOffered.clear();
  heldCards = [];
  cardQueue.length = 0;
  setStatus({ kind: "idle" });
}

// Show a card now, or after the one that's up.
function showCard(s: TrackTimerStatus) {
  if (isCard(status)) cardQueue.push(s);
  else setStatus(s);
}

// A finished track's result goes up straight away (a suggestion or summary
// that was up waits behind it).
function showResult(s: TrackTimerStatus) {
  if (status.kind === "suggest" || status.kind === "summary" || status.kind === "saved") cardQueue.unshift(status);
  setStatus(s);
}

// RecordRun calls this while it's timing a track itself.
export function suppressTrackTimer(segmentId: string, on: boolean) {
  if (on) {
    suppressed.add(segmentId);
    attempts.delete(segmentId);
    attempts.delete(`rev:${segmentId}`);
    publishTiming();
  } else {
    suppressed.delete(segmentId);
  }
}

// A newly created track should be timeable straight away.
export function refreshTrackTimerTracks() {
  fetchedAt = 0;
}

// Closes the card that's up. `remember` (a suggestion you said no to):
// don't suggest that road again. A card that just timed out isn't a no.
export function dismissTrackTimerResult(remember = true) {
  if (!isCard(status)) return;
  if (status.kind === "suggest" && remember && status.suggestion.reason !== "reverse") {
    rememberDismissed(status.suggestion);
  }
  const next = cardQueue.shift();
  if (next) setStatus(next);
  else publishTiming(true);
}

// The list of tracks timed on this drive (from a result card's link).
export function showDriveSummary() {
  if (driveLog.length === 0) return;
  const s: TrackTimerStatus = { kind: "summary", entries: [...driveLog] };
  if (isCard(status)) cardQueue.unshift(status);
  setStatus(s);
}

export function getDriveLog(): DriveLogEntry[] {
  return driveLog;
}

// Save the suggested track (with your drive as its first time).
export async function saveSuggestedTrack(name: string): Promise<boolean> {
  if (status.kind !== "suggest" || !deviceId) return false;
  const sug = status.suggestion;
  const forDevice = deviceId;
  const trackName = name.trim().slice(0, 60) || sug.name;
  try {
    const created = await api.createSegment(trackName, sug.trace, forDevice, sug.maxSpeedKmh, false);
    if (deviceId !== forDevice) return false;
    refreshTrackTimerTracks();
    setStatus({ kind: "saved", segmentId: created.id, segmentName: created.name, result: created.run });
    return true;
  } catch {
    return false;
  }
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
      tracks = buildTracks(list);
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

// Every track, plus a backwards copy of each one that doesn't already have
// a track of its own the other way.
export function buildTracks(list: SegmentSummary[]): Track[] {
  const real = list
    .filter((s) => Array.isArray(s.points) && s.points.length >= 2 && s.lengthM > 50)
    .map((s) => ({
      ...s,
      cumDist: cumulativeDistances(s.points),
      isLoop: haversine(s.points[0], s.points[s.points.length - 1]) < LOOP_CLOSE_M,
    }));
  const out: Track[] = [...real];
  for (const t of real) {
    const start = t.points[0];
    const end = t.points[t.points.length - 1];
    const hasOtherWay = real.some(
      (o) =>
        o.id !== t.id &&
        Math.abs(o.lengthM - t.lengthM) < Math.max(100, t.lengthM * 0.1) &&
        (t.isLoop
          ? // A loop the other way starts in the same place: compare the
            // first stretch of one with the last stretch of the other.
            haversine(o.points[0], start) < REVERSE_MATCH_M &&
            haversine(o.points[Math.min(5, o.points.length - 1)], t.points[Math.max(0, t.points.length - 6)]) <
              REVERSE_MATCH_M
          : haversine(o.points[0], end) < REVERSE_MATCH_M && haversine(o.points[o.points.length - 1], start) < REVERSE_MATCH_M)
    );
    if (hasOtherWay) continue;
    const points = [...t.points].reverse();
    out.push({ ...t, id: `rev:${t.id}`, reverseOf: t.id, points, cumDist: cumulativeDistances(points) });
  }
  return out;
}

// The attempt furthest along is the one the tag shows.
function publishTiming(force = false) {
  if (!force && (isCard(status) || status.kind === "saving")) return;
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
          segmentName:
            (lead.track.reverseOf ? `${lead.track.name} (backwards)` : lead.track.name) +
            (lead.lap > 1 ? ` -- lap ${lead.lap}` : ""),
          startedAt: lead.trace[0].t,
          progress: Math.min(1, lead.distanceM / (lead.track.cumDist[lead.track.cumDist.length - 1] || 1)),
        }
      : { kind: "idle" }
  );
}

async function submit(a: Attempt) {
  if (!deviceId) return;
  // Driven backwards: not a time on that track -- offer it as a new one.
  if (a.track.reverseOf) {
    if (reverseOffered.has(a.track.reverseOf)) return;
    reverseOffered.add(a.track.reverseOf);
    const durationMs = a.trace[a.trace.length - 1].t - a.trace[0].t;
    // Held until you park -- nothing to tap while you're driving.
    heldCards.push({
      kind: "suggest",
      suggestion: {
        reason: "reverse",
        name: `${a.track.name} (reverse)`.slice(0, 60),
        trace: a.trace,
        distanceM: a.track.lengthM,
        durationMs,
        maxSpeedKmh: a.maxSpeedKmh,
        timesDriven: 1,
        reverseOfName: a.track.name,
      },
    });
    return;
  }
  const forDevice = deviceId;
  if (!isCard(status)) setStatus({ kind: "saving", segmentName: a.track.name });
  try {
    const result = await api.submitRun(a.track.id, forDevice, a.trace, a.maxSpeedKmh);
    if (deviceId !== forDevice) return;
    driveLog.push({
      segmentId: a.track.id,
      segmentName: a.track.name,
      durationMs: result.durationMs,
      rank: result.rank,
      totalRuns: result.totalRuns,
      isNewRecord: result.isNewRecord,
      lap: a.lap,
    });
    showResult({
      kind: "result",
      segmentId: a.track.id,
      segmentName: a.track.name,
      result,
      at: Date.now(),
      lap: a.lap,
      driveCount: driveLog.length,
    });
  } catch {
    // Didn't validate (cut a corner, GPS gap...) -- silently not a time.
    publishTiming(status.kind === "saving");
  }
}

// ---- Drives: the summary, and track suggestions ----------------------

function storageKey(kind: string) {
  return `phantom.${kind}.${deviceId}`;
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown) {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not worth bothering anyone about.
  }
}

type Ends = { start: LatLng; end: LatLng };
// Said no to this session (also stored, but the write is async).
const recentDismissed: Ends[] = [];

function rememberDismissed(sug: TrackSuggestionCard) {
  if (!deviceId || sug.trace.length < 2) return;
  const key = storageKey("dismissedTracks");
  const ends: Ends = {
    start: { lat: sug.trace[0].lat, lng: sug.trace[0].lng },
    end: { lat: sug.trace[sug.trace.length - 1].lat, lng: sug.trace[sug.trace.length - 1].lng },
  };
  recentDismissed.push(ends);
  readJson<Ends[]>(key, []).then((list) => writeJson(key, [...list, ends].slice(-50)));
}

function addToDrive(fix: Fix, t: number) {
  const p: DrivePoint = { lat: fix.lat, lng: fix.lng, t, speedKmh: fix.speedKmh };
  const last = drive[drive.length - 1];
  if (!last || haversine(last, p) >= DRIVE_SPACING_M) {
    drive.push(p);
    if (drive.length > DRIVE_MAX_POINTS) drive.splice(0, drive.length - DRIVE_MAX_POINTS);
  } else if ((fix.speedKmh ?? 0) > (last.speedKmh ?? 0)) {
    last.speedKmh = fix.speedKmh;
  }
}

function driveLengthM(points: LatLng[]) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
  return d;
}

function defaultName(reason: "repeat" | "fast") {
  const d = new Date();
  const date = `${d.getMonth() + 1}/${d.getDate()}`;
  return reason === "repeat" ? `My road ${date}` : `Quick stretch ${date}`;
}

// The drive's over (parked a while, or a long gap): show what it timed,
// look for a track worth suggesting, and remember where it went.
async function endDrive() {
  if (endingDrive || !deviceId) return;
  const finished = drive;
  const log = driveLog;
  const held = heldCards;
  drive = [];
  driveLog = [];
  heldCards = [];
  reverseOffered.clear();
  if (log.length >= 2) showCard({ kind: "summary", entries: log });
  held.forEach(showCard);
  if (finished.length < 5 || driveLengthM(finished) < MIN_SUGGEST_M) return;
  endingDrive = true;
  const forDevice = deviceId;
  try {
    // A track made on this drive must count as a track already.
    if (fetchedAt === 0) {
      const list = await api.listSegments(forDevice).catch(() => null);
      if (list && deviceId === forDevice) {
        tracks = buildTracks(list);
        fetchedAt = Date.now();
      }
    }
    const historyKey = storageKey("driveHistory");
    const [history, dismissed, lastFastAt] = await Promise.all([
      readJson<PastDrive[]>(historyKey, []),
      readJson<Ends[]>(storageKey("dismissedTracks"), []),
      readJson<number>(storageKey("lastFastSuggestAt"), 0),
    ]);
    if (deviceId !== forDevice) return;
    const sug = suggestTrack(
      finished,
      history,
      tracks.filter((t) => !t.reverseOf).map((t) => t.points),
      [...dismissed, ...recentDismissed]
    );
    const fastOk = Date.now() - lastFastAt > FAST_SUGGEST_GAP_MS;
    if (sug && (sug.reason === "repeat" || fastOk)) {
      if (sug.reason === "fast") writeJson(storageKey("lastFastSuggestAt"), Date.now());
      showCard({
        kind: "suggest",
        suggestion: {
          reason: sug.reason,
          name: defaultName(sug.reason),
          trace: sug.trace.map((p) => ({ lat: p.lat, lng: p.lng, t: p.t })),
          distanceM: sug.distanceM,
          durationMs: sug.durationMs,
          maxSpeedKmh: sug.maxSpeedKmh,
          timesDriven: sug.timesDriven,
        },
      });
    }
    const past: PastDrive = { at: Date.now(), points: thinBySpacing(finished, HISTORY_SPACING_M, HISTORY_MAX_POINTS).map((p) => ({ lat: p.lat, lng: p.lng })) };
    await writeJson(historyKey, [...history, past].slice(-HISTORY_DRIVES));
  } catch (e) {
    console.warn("Drive summary failed:", e);
  } finally {
    endingDrive = false;
  }
}

// Parked for a while with the app up: that drive's over.
setInterval(() => {
  if (drive.length === 0 && driveLog.length === 0) return;
  const now = Date.now();
  if (lastMovingAt > 0 && now - lastMovingAt > PARKED_MS) {
    // Anything still "under way" stalled minutes ago.
    attempts.clear();
    endDrive();
    publishTiming();
  }
}, 30000);

// One GPS fix, from whichever screen is watching. Cheap enough per fix.
export function feedTrackTimer(fix: Fix) {
  if (!deviceId || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return;
  const t = fix.t || Date.now();
  if (t < lastFixT + MIN_FIX_GAP_MS) return;
  const gapMs = lastFixT ? t - lastFixT : 1000;
  // A long silence: whatever drive came before it is over.
  if (lastFixT && gapMs > DRIVE_GAP_MS) {
    attempts.clear();
    endDrive();
  }
  lastFixT = t;
  const pos = { lat: fix.lat, lng: fix.lng };
  maybeFetch(pos);
  const point = { lat: fix.lat, lng: fix.lng, t };
  if (fix.speedKmh >= MOVING_KMH) lastMovingAt = Date.now();
  if (fix.speedKmh >= MOVING_KMH || drive.length > 0) addToDrive(fix, t);

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
    // On a loop, rolling up to the line can look like you're at the end of
    // the lap (it's the same place) -- that's the start too.
    const atStart = haversine(a.track.points[0], pos) < ARM_RADIUS_M;
    const snappedToEnd = a.track.isLoop && distanceAlongM > length / 2 && a.travelledM < 100;
    if (atStart && (distanceAlongM < 5 || snappedToEnd)) {
      a.trace = [point];
      a.distanceM = snappedToEnd ? 0 : distanceAlongM;
      a.travelledM = 0;
      a.lastHeadwayAt = t;
      continue;
    }
    a.travelledM += haversine(a.trace[a.trace.length - 1], point);
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
    if (a.distanceM >= finishAt && a.trace.length >= 3 && t - a.trace[0].t >= 3000 && a.travelledM >= length * 0.85) {
      attempts.delete(id);
      submit(a);
      // Round a loop again: the next lap starts right here.
      if (a.track.isLoop && !a.track.reverseOf && !suppressed.has(a.track.id)) {
        attempts.set(id, {
          track: a.track,
          trace: [point],
          distanceM: 0,
          maxSpeedKmh: fix.speedKmh,
          offTrackFixes: 0,
          lastHeadwayAt: t,
          lap: a.lap + 1,
          travelledM: 0,
        });
      }
    }
  }

  // Arm any track whose start you're rolling through.
  if (fix.speedKmh >= ARM_MIN_SPEED_KMH) {
    for (const track of tracks) {
      if (attempts.has(track.id) || suppressed.has(track.reverseOf ?? track.id)) continue;
      const d = haversine(track.points[0], pos);
      if (d > NEARBY_M || d > ARM_RADIUS_M) continue;
      attempts.set(track.id, {
        track,
        trace: [point],
        distanceM: 0,
        maxSpeedKmh: fix.speedKmh,
        offTrackFixes: 0,
        lastHeadwayAt: t,
        lap: 1,
        travelledM: 0,
      });
    }
  }

  publishTiming();
}
