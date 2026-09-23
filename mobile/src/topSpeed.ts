import { api } from "./api/client";

// Your fastest speed, tracked the whole time the app is open -- not just
// while recording a track, driving a Go To trip or racing someone. Every
// screen that watches GPS calls recordSpeed() with each fix; this module
// keeps the best one and pushes new personal bests to your account, so the
// number survives a reinstall and can rank you on the worldwide top-speed
// board without you having recorded anything at all.
//
// Deliberately module-level rather than a hook/context: there's exactly one
// "fastest you've ever gone", several screens feed it, and it has to keep
// its state across navigation between them.

// Above this is a GPS glitch, not a drive (the backend rejects these too).
const MAX_PLAUSIBLE_KMH = 350;
// A new best is only believed if the previous fix was already going at
// least this fraction of it. A single wild sample between two slow ones --
// the classic GPS jump indoors or under a bridge -- is ignored; real
// acceleration always has a fast fix right behind it, a second earlier.
const CORROBORATION_RATIO = 0.6;
// New bests are batched rather than posted per fix: hard acceleration sets
// a new record on every single GPS tick otherwise.
const POST_DEBOUNCE_MS = 10000;

let deviceId: string | null = null;
let best = 0;
let lastSampleKmh = 0;
let pendingBest = 0;
let postTimer: ReturnType<typeof setTimeout> | null = null;

// Called when the signed-in account changes (including logging out, with
// null). Pulls the stored best down so a session that never beats it never
// posts anything.
export function setTopSpeedUser(nextDeviceId: string | null) {
  if (nextDeviceId === deviceId) return;
  deviceId = nextDeviceId;
  best = 0;
  lastSampleKmh = 0;
  pendingBest = 0;
  if (postTimer) {
    clearTimeout(postTimer);
    postTimer = null;
  }
  if (!nextDeviceId) return;
  api
    .getTopSpeed(nextDeviceId)
    .then((r) => {
      // Guard against the account changing again while this was in flight.
      if (deviceId === nextDeviceId && r.topSpeedKmh > best) best = r.topSpeedKmh;
    })
    .catch(() => {
      // Offline or the server's asleep -- we just start from 0 for this
      // session and may re-post a best the server already has, which it
      // simply keeps (it stores the max).
    });
}

// One GPS fix's speed, in km/h. Safe to call on every fix from anywhere.
export function recordSpeed(speedKmh: number) {
  if (!Number.isFinite(speedKmh) || speedKmh <= 0 || speedKmh > MAX_PLAUSIBLE_KMH) {
    lastSampleKmh = 0;
    return;
  }
  const previous = lastSampleKmh;
  lastSampleKmh = speedKmh;
  if (speedKmh <= best) return;
  if (previous < speedKmh * CORROBORATION_RATIO) return;
  best = speedKmh;
  pendingBest = speedKmh;
  schedulePost();
}

function schedulePost() {
  if (postTimer || !deviceId) return;
  postTimer = setTimeout(() => {
    postTimer = null;
    flushTopSpeed();
  }, POST_DEBOUNCE_MS);
}

// Sends whatever new best is waiting, if any. Called on the debounce timer
// and directly when a screen loses focus or a drive ends, so a best set in
// the last few seconds isn't lost if the app is closed right after.
export function flushTopSpeed() {
  const id = deviceId;
  const value = pendingBest;
  if (!id || value <= 0) return;
  pendingBest = 0;
  api.reportTopSpeed(id, value).catch(() => {
    // Keep it queued for the next flush rather than losing the record.
    if (value > pendingBest) pendingBest = value;
  });
}

// The best known right now (server's stored best, raised by anything this
// session has seen) -- used by the Stats screen so your top speed shows up
// there immediately, without waiting for a round trip.
export function knownTopSpeedKmh() {
  return best;
}
