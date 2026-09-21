// Need for Speed (real life) -- MVP backend.
//
// Uses a plain Node "http" server (no framework). Storage is handled by
// db.js: a JSON file locally, or MongoDB Atlas when deployed (see db.js for
// details) -- the route handlers below just `await db.load()` / `await
// db.save()` and don't care which one is actually in use.
//
// Concept: "segments" are stretches of real road (a polyline of GPS points),
// like a Strava segment. Users record a run along a segment; the backend
// times it and ranks it on a leaderboard. The mobile app additionally races
// you live against the leaderboard leader ("ghost") using the profile data
// this server computes.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const crypto = require("crypto");
const db = require("./db");
const geo = require("./geo");

const PORT = process.env.PORT || 4000;

// A server-side-only Google Maps Platform key (Places + Directions APIs
// enabled, no app/referrer restriction since it's never shipped to a
// client) -- distinct from the key baked into the mobile app, which only
// has the Maps SDK enabled. Set as an env var on the deployed host; local
// dev without it just gets a clear "not configured" error from the routes
// that need it instead of a confusing Google API failure.
const GOOGLE_SERVER_API_KEY = process.env.GOOGLE_SERVER_API_KEY;

// Live head-to-head race challenges: fixed set of distances, matching the
// classic drag-race lengths the user asked for. Kept as a name->meters map
// (not user-editable) so both server and client always agree on exactly what
// "1 MILE" means -- mirrored client-side in mobile/src/raceDistances.ts.
const RACE_DISTANCES = {
  quarter: { meters: 402.336, label: "1/4 MILE" },
  mile: { meters: 1609.344, label: "1 MILE" },
  five: { meters: 8046.72, label: "5 MILES" },
};
// A race request left unanswered this long is treated as expired -- the two
// racers are physically near each other right now, so a request that sits
// unanswered for minutes stops meaning anything (they may have driven apart
// already).
const RACE_REQUEST_TIMEOUT_MS = 45000;
// Gap between "accepted" and the actual start, so both phones can count down
// from the same server-issued timestamp rather than starting the instant
// each individual device happens to receive the accept.
const RACE_COUNTDOWN_MS = 5000;

// How close (meters) two racers have to be for proximity voice to connect
// them -- deliberately much tighter than presence's map-viewport query or a
// track's 5km "nearby" radius: this is meant to feel like "close enough to
// yell at from the next car over," not "somewhere in the same city."
const VOICE_RADIUS_M = 500;

// Minimal HTTPS GET-JSON helper, built on Node's own `https` (no axios/
// node-fetch) to keep this backend's zero-dependency design -- used only
// for the handful of Google Places/Directions calls below.
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error("Bad response from Google"));
          }
        });
      })
      .on("error", reject);
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function findUserByDevice(dbState, deviceId) {
  return dbState.users.find((u) => u.deviceId === deviceId);
}

function findUserByName(dbState, displayName) {
  const lower = displayName.toLowerCase();
  return dbState.users.find((u) => u.displayName.toLowerCase() === lower);
}

// Password hashing via Node's built-in crypto (scrypt) -- no extra
// dependency needed, keeping with this backend's zero-dependency design.
// Stored as "<salt>:<hash>", both hex.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const hashBuffer = Buffer.from(hash, "hex");
  const testHash = crypto.scryptSync(password, salt, 64);
  return testHash.length === hashBuffer.length && crypto.timingSafeEqual(testHash, hashBuffer);
}

// The subset of a user record that's safe to send to the client --
// never the password hash.
function publicUser(user) {
  return { id: user.id, deviceId: user.deviceId, displayName: user.displayName, createdAt: user.createdAt };
}

// A run whose average speed is not physically plausible -- either an
// absurd absolute speed, or higher than the phone's own recorded top
// speed for that same run (average can never exceed max) -- almost
// certainly means the GPS trace was mismatched onto the segment (e.g.
// the live position momentarily projected near the segment's far end)
// rather than a real drive. Used both to reject new submissions and to
// clean out any that already slipped through.
function isImplausibleRun(avgSpeedKmh, maxSpeedKmh) {
  return avgSpeedKmh > 300 || (maxSpeedKmh > 0 && avgSpeedKmh > maxSpeedKmh * 1.2);
}

// Validates a GPS trace against a segment and, if it checks out, times it
// and stores it as a run. Shared by the dedicated "submit a run" endpoint
// and by segment creation (the drive that just defined the segment is
// itself a full lap of it, so it's auto-submitted as that segment's first
// run). Returns { run, error } -- run is a plain submit-run-response object
// on success, or null with `error` set to why it didn't count. The caller
// decides whether that should fail the whole request (submitting a run:
// yes) or just be reported alongside an otherwise-successful save
// (creating a segment: no -- the segment is kept either way).
function tryCreateRun(state, segment, user, cleanTrace, maxSpeedKmh) {
  const segCumDist = geo.cumulativeDistances(segment.points);
  const validation = geo.validateRunAgainstSegment(segment.points, segCumDist, cleanTrace);
  if (!validation.valid) {
    return { run: null, error: validation.reason };
  }

  const durationMs = cleanTrace[cleanTrace.length - 1].t - cleanTrace[0].t;
  if (!(durationMs > 0)) {
    return { run: null, error: "Invalid trace timestamps." };
  }
  const avgSpeedKmh = (segment.lengthM / 1000) / (durationMs / 3_600_000);

  // Client-reported top speed, from the phone's GPS speed sensor. Sanity
  // checked (not just trusted) since GPS speed can spike from noise or a
  // spoofed value: must be a finite, non-negative number, and clamped to a
  // generous but real-world ceiling.
  const rawMaxSpeed = Number(maxSpeedKmh);
  const safeMaxSpeedKmh =
    Number.isFinite(rawMaxSpeed) && rawMaxSpeed > 0 ? Math.round(Math.min(rawMaxSpeed, 350) * 10) / 10 : 0;

  const roundedAvg = Math.round(avgSpeedKmh * 10) / 10;
  if (isImplausibleRun(roundedAvg, safeMaxSpeedKmh)) {
    return {
      run: null,
      error: "This run's average speed isn't physically plausible for this segment -- not counted.",
    };
  }

  const run = {
    id: db.id("run"),
    segmentId: segment.id,
    userId: user.id,
    durationMs,
    avgSpeedKmh: roundedAvg,
    maxSpeedKmh: safeMaxSpeedKmh,
    trace: cleanTrace,
    recordedAt: new Date().toISOString(),
  };
  state.runs.push(run);

  const allRuns = state.runs
    .filter((r) => r.segmentId === segment.id)
    .sort((a, b) => a.durationMs - b.durationMs);
  const rank = allRuns.findIndex((r) => r.id === run.id) + 1;

  return {
    run: {
      runId: run.id,
      durationMs: run.durationMs,
      avgSpeedKmh: run.avgSpeedKmh,
      maxSpeedKmh: run.maxSpeedKmh,
      rank,
      totalRuns: allRuns.length,
      isNewRecord: rank === 1,
    },
    error: null,
  };
}

function segmentSummary(dbState, segment) {
  const runs = dbState.runs
    .filter((r) => r.segmentId === segment.id)
    .sort((a, b) => a.durationMs - b.durationMs);
  const best = runs[0];
  return {
    id: segment.id,
    name: segment.name,
    lengthM: segment.lengthM,
    points: segment.points,
    createdAt: segment.createdAt,
    runCount: runs.length,
    bestTimeMs: best ? best.durationMs : null,
    bestTimeUser: best ? dbState.users.find((u) => u.id === best.userId)?.displayName ?? "Unknown" : null,
    creatorId: segment.creatorId,
    isPrivate: !!segment.isPrivate,
  };
}

// A private segment is visible/raceable only by whoever created it -- every
// route that reads or lists a specific segment checks this before returning
// anything, so a private track's existence isn't even leaked to anyone else
// (a stranger hitting its id directly gets the same "Segment not found" as a
// made-up id, not a 403 that would confirm it exists). `deviceId` is
// whoever's asking, looked up fresh each time (not trusted from the client)
// so this can't be spoofed by just sending someone else's id.
function canAccessSegment(dbState, segment, deviceId) {
  if (!segment.isPrivate) return true;
  const caller = deviceId ? findUserByDevice(dbState, deviceId) : null;
  return !!caller && segment.creatorId === caller.id;
}

// A pending request nobody's answered within RACE_REQUEST_TIMEOUT_MS is
// stale -- flips it to "expired" in place. Called at the top of every route
// that reads or mutates a race, so nothing needs a background cleanup job;
// the flip just happens (and gets persisted, since every such route saves
// state afterward) the next time anyone touches that race.
function normalizeRaceStatus(race) {
  if (race.status === "pending" && Date.now() - new Date(race.createdAt).getTime() > RACE_REQUEST_TIMEOUT_MS) {
    race.status = "expired";
  }
  return race;
}

// Client-facing view of a race challenge, from one specific viewer's side --
// "my" vs "opponent" rather than "from" vs "to", so the same shape works
// whether the viewer sent or received the challenge, and the client never
// has to juggle which field is which.
function raceSummary(dbState, race, viewerUserId) {
  const opponentId = race.fromUserId === viewerUserId ? race.toUserId : race.fromUserId;
  const fromUser = dbState.users.find((u) => u.id === race.fromUserId);
  const toUser = dbState.users.find((u) => u.id === race.toUserId);
  const opponentUser = dbState.users.find((u) => u.id === opponentId);
  const dist = RACE_DISTANCES[race.distanceKey];
  return {
    id: race.id,
    distanceKey: race.distanceKey,
    distanceM: dist ? dist.meters : race.distanceM,
    distanceLabel: dist ? dist.label : "",
    status: race.status,
    createdAt: race.createdAt,
    raceStartAt: race.raceStartAt || null,
    isChallenger: race.fromUserId === viewerUserId,
    fromDisplayName: fromUser?.displayName ?? "Unknown",
    toDisplayName: toUser?.displayName ?? "Unknown",
    opponentDisplayName: opponentUser?.displayName ?? "Unknown",
    myProgress: race.progress?.[viewerUserId] ?? null,
    opponentProgress: race.progress?.[opponentId] ?? null,
    myResult: race.results?.[viewerUserId] ?? null,
    opponentResult: race.results?.[opponentId] ?? null,
  };
}

// True if either user has blocked the other -- checked both directions, so
// blocking someone hides you from them just as much as it hides them from
// you (neither side gets offered as a voice peer, and neither can reach the
// other via the signaling relay even by guessing a deviceId).
function isBlockedPair(dbState, userIdA, userIdB) {
  return dbState.blocks.some(
    (b) =>
      (b.blockerUserId === userIdA && b.blockedUserId === userIdB) ||
      (b.blockerUserId === userIdB && b.blockedUserId === userIdA)
  );
}

const routes = [];
function route(method, pattern, handler) {
  // pattern like "/api/segments/:id/runs" -> regex with named groups
  const paramNames = [];
  const regexStr =
    "^" +
    pattern
      .split("/")
      .map((part) => {
        if (part.startsWith(":")) {
          paramNames.push(part.slice(1));
          return "([^/]+)";
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/") +
    "$";
  routes.push({ method, regex: new RegExp(regexStr), paramNames, handler });
}

async function dispatch(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = r.regex.exec(url.pathname);
    if (!match) continue;
    const params = {};
    r.paramNames.forEach((name, i) => (params[name] = match[i + 1]));
    try {
      const body = ["POST", "PUT", "PATCH"].includes(req.method)
        ? await readBody(req)
        : {};
      await r.handler({ req, res, params, query: url.searchParams, body });
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Bad request" });
    }
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}

// ---- Routes ---------------------------------------------------------------

route("GET", "/api/health", async ({ res }) => {
  sendJson(res, 200, { ok: true, time: new Date().toISOString() });
});

// Create a real account: a racer name + password, so it (and everything
// tied to it -- leaderboard history, segments you've created) can be logged
// back into from any device, not just the one you signed up on. If the name
// belongs to an existing account that has no password yet (from before
// accounts existed), this claims it instead of erroring, so nothing about
// that history is lost.
route("POST", "/api/auth/register", async ({ res, body }) => {
  const name = (body.displayName || "").trim();
  const password = body.password || "";
  if (!name) return sendJson(res, 400, { error: "Pick a racer name." });
  if (password.length < 4) return sendJson(res, 400, { error: "Password must be at least 4 characters." });

  const state = await db.load();
  const existing = findUserByName(state, name);

  let user;
  if (existing && existing.passwordHash) {
    return sendJson(res, 409, { error: "That name is already taken. Try logging in, or pick a different name." });
  } else if (existing) {
    existing.passwordHash = hashPassword(password);
    user = existing;
  } else {
    user = {
      id: db.id("user"),
      deviceId: db.id("device"),
      displayName: name,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    state.users.push(user);
  }
  await db.save(state);
  sendJson(res, 200, publicUser(user));
});

// Log in from any device with a racer name + password, to pick up that
// account's saved name and leaderboard history here.
route("POST", "/api/auth/login", async ({ res, body }) => {
  const name = (body.displayName || "").trim();
  const password = body.password || "";
  if (!name || !password) return sendJson(res, 400, { error: "Name and password are required." });

  const state = await db.load();
  const user = findUserByName(state, name);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return sendJson(res, 401, { error: "Incorrect name or password." });
  }
  sendJson(res, 200, publicUser(user));
});

// Rename an already-signed-in account. No password needed -- you're
// already authenticated by having this device's saved account.
route("PATCH", "/api/users/:deviceId", async ({ res, params, body }) => {
  const name = (body.displayName || "").trim();
  if (!name) return sendJson(res, 400, { error: "Pick a racer name." });

  const state = await db.load();
  const user = findUserByDevice(state, params.deviceId);
  if (!user) return sendJson(res, 404, { error: "User not found." });

  const clash = findUserByName(state, name);
  if (clash && clash.id !== user.id) {
    return sendJson(res, 409, { error: "That name is taken." });
  }

  user.displayName = name;
  await db.save(state);
  sendJson(res, 200, publicUser(user));
});

// List all segments with a leaderboard summary. `deviceId` is optional (an
// anonymous/unauthenticated caller just sees public segments) -- when
// present, it also gets back their own private segments alongside every
// public one, same as before this existed.
route("GET", "/api/segments", async ({ res, query }) => {
  const state = await db.load();
  const deviceId = (query.get("deviceId") || "").trim();
  const caller = deviceId ? findUserByDevice(state, deviceId) : null;
  const visible = state.segments.filter((s) => !s.isPrivate || (caller && s.creatorId === caller.id));
  sendJson(
    res,
    200,
    visible.map((s) => segmentSummary(state, s))
  );
});

// Create a new segment from a recorded polyline. The trace that defines the
// segment is a full lap of it, so it's auto-submitted as that segment's
// first timed run (see tryCreateRun) -- the response carries both the
// segment and (if the trace was a valid, plausible run) that first run.
route("POST", "/api/segments", async ({ res, body }) => {
  const { name, trace, deviceId, maxSpeedKmh, isPrivate } = body;
  if (!name || !Array.isArray(trace) || trace.length < 2) {
    return sendJson(res, 400, {
      error: "name and a trace of at least 2 {lat,lng,t} points are required",
    });
  }
  const state = await db.load();
  const creator = findUserByDevice(state, deviceId);
  if (!creator) return sendJson(res, 400, { error: "Unknown deviceId; register the user first." });

  const cleanTrace = trace.map((p) => ({
    lat: Number(p.lat),
    lng: Number(p.lng),
    t: Number(p.t),
  }));
  const cleanPoints = cleanTrace.map((p) => ({ lat: p.lat, lng: p.lng }));

  const segment = {
    id: db.id("seg"),
    name,
    points: cleanPoints,
    lengthM: Math.round(geo.polylineLength(cleanPoints)),
    creatorId: creator.id,
    isPrivate: !!isPrivate,
    createdAt: new Date().toISOString(),
  };
  state.segments.push(segment);

  const { run, error: runError } = tryCreateRun(state, segment, creator, cleanTrace, maxSpeedKmh);

  await db.save(state);
  sendJson(res, 201, { ...segmentSummary(state, segment), run, runError: run ? null : runError });
});

// Flip a segment you created between private and public -- the "start
// private, make it public later if you change your mind" half of private
// tracks. Ownership-checked: only the creator's device can do this.
route("PATCH", "/api/segments/:id", async ({ res, params, body }) => {
  const deviceId = (body.deviceId || "").trim();
  const state = await db.load();
  const segment = state.segments.find((s) => s.id === params.id);
  if (!segment) return sendJson(res, 404, { error: "Segment not found" });

  const caller = deviceId ? findUserByDevice(state, deviceId) : null;
  if (!caller || segment.creatorId !== caller.id) {
    return sendJson(res, 403, { error: "Only the creator can change this track's privacy." });
  }
  segment.isPrivate = !!body.isPrivate;
  await db.save(state);
  sendJson(res, 200, segmentSummary(state, segment));
});

route("GET", "/api/segments/:id", async ({ res, params, query }) => {
  const state = await db.load();
  const segment = state.segments.find((s) => s.id === params.id);
  if (!segment || !canAccessSegment(state, segment, query.get("deviceId"))) {
    return sendJson(res, 404, { error: "Segment not found" });
  }
  sendJson(res, 200, segmentSummary(state, segment));
});

route("GET", "/api/segments/:id/leaderboard", async ({ res, params, query }) => {
  const state = await db.load();
  const segment = state.segments.find((s) => s.id === params.id);
  if (!segment || !canAccessSegment(state, segment, query.get("deviceId"))) {
    return sendJson(res, 404, { error: "Segment not found" });
  }

  const runs = state.runs
    .filter((r) => r.segmentId === segment.id)
    .sort((a, b) => a.durationMs - b.durationMs)
    .map((r, i) => ({
      rank: i + 1,
      runId: r.id,
      userId: r.userId,
      displayName: state.users.find((u) => u.id === r.userId)?.displayName ?? "Unknown",
      durationMs: r.durationMs,
      avgSpeedKmh: r.avgSpeedKmh,
      maxSpeedKmh: r.maxSpeedKmh ?? 0,
      recordedAt: r.recordedAt,
    }));

  sendJson(res, 200, { segmentId: segment.id, segmentName: segment.name, leaderboard: runs });
});

// Submit a completed run: validates the GPS trace actually covers the
// segment, computes duration + rank, and stores it.
route("POST", "/api/segments/:id/runs", async ({ res, params, body }) => {
  const { deviceId, trace, maxSpeedKmh } = body;
  if (!deviceId || !Array.isArray(trace) || trace.length < 2) {
    return sendJson(res, 400, {
      error: "deviceId and a trace of at least 2 {lat,lng,t} points are required",
    });
  }

  const state = await db.load();
  const segment = state.segments.find((s) => s.id === params.id);
  if (!segment || !canAccessSegment(state, segment, deviceId)) {
    return sendJson(res, 404, { error: "Segment not found" });
  }

  const user = findUserByDevice(state, deviceId);
  if (!user) return sendJson(res, 400, { error: "Unknown deviceId; register the user first." });

  const cleanTrace = trace.map((p) => ({
    lat: Number(p.lat),
    lng: Number(p.lng),
    t: Number(p.t),
  }));

  const { run, error } = tryCreateRun(state, segment, user, cleanTrace, maxSpeedKmh);
  if (!run) {
    return sendJson(res, 422, { error });
  }
  await db.save(state);
  sendJson(res, 201, run);
});

// The current leaderboard leader's run, packaged as a "ghost profile" the
// mobile app can race against live (distance -> elapsed-time samples).
route("GET", "/api/segments/:id/ghost", async ({ res, params, query }) => {
  const state = await db.load();
  const segment = state.segments.find((s) => s.id === params.id);
  if (!segment || !canAccessSegment(state, segment, query.get("deviceId"))) {
    return sendJson(res, 404, { error: "Segment not found" });
  }

  const runs = state.runs
    .filter((r) => r.segmentId === segment.id)
    .sort((a, b) => a.durationMs - b.durationMs);

  const runId = query.get("runId");
  const targetRun = runId ? runs.find((r) => r.id === runId) : runs[0];
  if (!targetRun) return sendJson(res, 404, { error: "No runs recorded on this segment yet." });

  const segCumDist = geo.cumulativeDistances(segment.points);
  const profile = geo.buildGhostProfile(segment.points, segCumDist, targetRun.trace);

  sendJson(res, 200, {
    runId: targetRun.id,
    displayName: state.users.find((u) => u.id === targetRun.userId)?.displayName ?? "Unknown",
    durationMs: targetRun.durationMs,
    profile, // [{distanceAlongM, elapsedMs}, ...]
  });
});

route("GET", "/api/users/:deviceId/runs", async ({ res, params }) => {
  const state = await db.load();
  const user = findUserByDevice(state, params.deviceId);
  if (!user) return sendJson(res, 404, { error: "User not found" });

  const runs = state.runs
    .filter((r) => r.userId === user.id)
    .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))
    .map((r) => ({
      runId: r.id,
      segmentId: r.segmentId,
      segmentName: state.segments.find((s) => s.id === r.segmentId)?.name ?? "Unknown",
      durationMs: r.durationMs,
      avgSpeedKmh: r.avgSpeedKmh,
      maxSpeedKmh: r.maxSpeedKmh ?? 0,
      // The actual recorded trace's length, not just the segment's nominal
      // length -- added for the stats screen's "distance driven" total.
      // Uses `trace` (kept on every run since day one) rather than the
      // segment's own lengthM so it reflects what was actually driven.
      distanceM: Math.round(geo.polylineLength(r.trace || [])),
      recordedAt: r.recordedAt,
    }));
  sendJson(res, 200, runs);
});

// ---- Go To a place: Places search + Directions routing + trip tracking ----
//
// These three routes back the "search a destination, see the route/ETA,
// then drive it" feature. All three proxy Google's REST APIs server-side
// (never exposing GOOGLE_SERVER_API_KEY to the app) -- see the comment on
// that constant above.

route("GET", "/api/places/autocomplete", async ({ res, query }) => {
  const input = (query.get("query") || "").trim();
  if (!input) return sendJson(res, 200, { predictions: [] });
  if (!GOOGLE_SERVER_API_KEY) {
    return sendJson(res, 500, { error: "Destination search isn't configured on the server yet." });
  }
  const lat = query.get("lat");
  const lng = query.get("lng");
  // Bias (not restrict) results toward wherever the phone currently is, so
  // "mcdonalds" finds the nearby one first instead of one in another city.
  const locationBias = lat && lng ? `&location=${lat},${lng}&radius=30000` : "";
  try {
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(
      input
    )}${locationBias}&key=${GOOGLE_SERVER_API_KEY}`;
    const data = await httpsGetJson(url);
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return sendJson(res, 502, { error: data.error_message || `Destination search failed (${data.status})` });
    }
    sendJson(res, 200, {
      predictions: (data.predictions || []).map((p) => ({ placeId: p.place_id, description: p.description })),
    });
  } catch (e) {
    sendJson(res, 502, { error: "Couldn't reach the destination search service." });
  }
});

route("GET", "/api/places/details", async ({ res, query }) => {
  const placeId = query.get("placeId");
  if (!placeId) return sendJson(res, 400, { error: "placeId is required" });
  if (!GOOGLE_SERVER_API_KEY) {
    return sendJson(res, 500, { error: "Destination search isn't configured on the server yet." });
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
      placeId
    )}&fields=name,formatted_address,geometry&key=${GOOGLE_SERVER_API_KEY}`;
    const data = await httpsGetJson(url);
    if (data.status !== "OK") {
      return sendJson(res, 422, { error: data.error_message || `Couldn't look up that place (${data.status})` });
    }
    const r = data.result;
    sendJson(res, 200, {
      placeId,
      name: r.name,
      address: r.formatted_address,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
    });
  } catch (e) {
    sendJson(res, 502, { error: "Couldn't reach the destination search service." });
  }
});

// Driving route + ETA between two points, used both for the initial preview
// (before you tap "Start") and for live rerouting when you stray off the
// planned route.
route("GET", "/api/directions", async ({ res, query }) => {
  const originLat = Number(query.get("originLat"));
  const originLng = Number(query.get("originLng"));
  const destLat = Number(query.get("destLat"));
  const destLng = Number(query.get("destLng"));
  if (![originLat, originLng, destLat, destLng].every(Number.isFinite)) {
    return sendJson(res, 400, { error: "originLat, originLng, destLat, destLng are required" });
  }
  if (!GOOGLE_SERVER_API_KEY) {
    return sendJson(res, 500, { error: "Routing isn't configured on the server yet." });
  }
  try {
    const url =
      `https://maps.googleapis.com/maps/api/directions/json?origin=${originLat},${originLng}` +
      `&destination=${destLat},${destLng}&mode=driving&key=${GOOGLE_SERVER_API_KEY}`;
    const data = await httpsGetJson(url);
    if (data.status !== "OK" || !data.routes || !data.routes.length) {
      return sendJson(res, 422, { error: data.error_message || `No route found (${data.status})` });
    }
    const route0 = data.routes[0];
    const leg = route0.legs[0];
    const points = geo.decodePolyline(route0.overview_polyline.points);
    sendJson(res, 200, {
      points,
      distanceM: leg.distance.value,
      durationS: leg.duration.value,
      durationInTrafficS: leg.duration_in_traffic ? leg.duration_in_traffic.value : null,
      endAddress: leg.end_address,
    });
  } catch (e) {
    sendJson(res, 502, { error: "Couldn't reach the routing service." });
  }
});

// Submit a completed "go to" drive. Unlike segment runs, a trip's start
// point is wherever you happened to be when you tapped Start (not a fixed,
// shared start line), so there's no leaderboard here -- this is purely a
// personal record of the drive, timed against the ETA Google gave you
// beforehand.
route("POST", "/api/trips", async ({ res, body }) => {
  const { deviceId, destinationName, destination, trace, maxSpeedKmh, estimatedDurationS } = body;
  if (
    !deviceId ||
    !destinationName ||
    !destination ||
    !Number.isFinite(Number(destination.lat)) ||
    !Number.isFinite(Number(destination.lng)) ||
    !Array.isArray(trace) ||
    trace.length < 2
  ) {
    return sendJson(res, 400, {
      error: "deviceId, destinationName, destination {lat,lng}, and a trace of at least 2 points are required",
    });
  }

  const state = await db.load();
  const user = findUserByDevice(state, deviceId);
  if (!user) return sendJson(res, 400, { error: "Unknown deviceId; register the user first." });

  const cleanTrace = trace.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), t: Number(p.t) }));
  const durationMs = cleanTrace[cleanTrace.length - 1].t - cleanTrace[0].t;
  if (!(durationMs > 0)) return sendJson(res, 400, { error: "Invalid trace timestamps." });

  const distanceM = Math.round(geo.polylineLength(cleanTrace));
  const avgSpeedKmh = Math.round((distanceM / 1000 / (durationMs / 3_600_000)) * 10) / 10;

  const rawMaxSpeed = Number(maxSpeedKmh);
  const safeMaxSpeedKmh =
    Number.isFinite(rawMaxSpeed) && rawMaxSpeed > 0 ? Math.round(Math.min(rawMaxSpeed, 350) * 10) / 10 : 0;

  const rawEstimateS = Number(estimatedDurationS);
  const estimatedDurationMs = Number.isFinite(rawEstimateS) && rawEstimateS > 0 ? rawEstimateS * 1000 : null;

  const trip = {
    id: db.id("trip"),
    userId: user.id,
    destinationName,
    destinationLat: Number(destination.lat),
    destinationLng: Number(destination.lng),
    startLat: cleanTrace[0].lat,
    startLng: cleanTrace[0].lng,
    trace: cleanTrace,
    durationMs,
    distanceM,
    avgSpeedKmh,
    maxSpeedKmh: safeMaxSpeedKmh,
    estimatedDurationMs,
    recordedAt: new Date().toISOString(),
  };
  state.trips = state.trips || [];
  state.trips.push(trip);
  await db.save(state);

  sendJson(res, 201, {
    tripId: trip.id,
    destinationName: trip.destinationName,
    durationMs: trip.durationMs,
    distanceM: trip.distanceM,
    avgSpeedKmh: trip.avgSpeedKmh,
    maxSpeedKmh: trip.maxSpeedKmh,
    estimatedDurationMs: trip.estimatedDurationMs,
    deltaMs: trip.estimatedDurationMs != null ? trip.durationMs - trip.estimatedDurationMs : null,
  });
});

route("GET", "/api/users/:deviceId/trips", async ({ res, params }) => {
  const state = await db.load();
  const user = findUserByDevice(state, params.deviceId);
  if (!user) return sendJson(res, 404, { error: "User not found" });

  const trips = (state.trips || [])
    .filter((t) => t.userId === user.id)
    .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))
    .map((t) => ({
      tripId: t.id,
      destinationName: t.destinationName,
      durationMs: t.durationMs,
      distanceM: t.distanceM,
      avgSpeedKmh: t.avgSpeedKmh,
      maxSpeedKmh: t.maxSpeedKmh,
      estimatedDurationMs: t.estimatedDurationMs,
      recordedAt: t.recordedAt,
    }));
  sendJson(res, 200, trips);
});

// A presence record older than this is treated as "not online" and dropped
// from query results -- the mobile app heartbeats roughly every 5s while
// foregrounded, so this gives room for one missed beat (a brief network
// blip) without the marker flickering out, while still going stale quickly
// once someone actually backgrounds/closes the app.
const PRESENCE_MAX_AGE_MS = 25000;

// Heartbeat: "I'm here, at this location, right now." Called repeatedly
// (not once) by any signed-in device while the app is foregrounded, per the
// chosen visibility model -- your marker is live to others for as long as
// heartbeats keep arriving, and simply times out (see PRESENCE_MAX_AGE_MS)
// once they stop, whether that's backgrounding the app, losing signal, or
// force-closing it. No separate start/stop call needed.
route("POST", "/api/presence", async ({ res, body }) => {
  const deviceId = (body.deviceId || "").trim();
  if (!deviceId) return sendJson(res, 400, { error: "Missing deviceId." });
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return sendJson(res, 400, { error: "Missing or invalid lat/lng." });
  }

  // Looked up fresh each heartbeat (not cached client-side) so a rename
  // shows up to everyone else within one heartbeat interval.
  const state = await db.load();
  const user = findUserByDevice(state, deviceId);
  if (!user) return sendJson(res, 404, { error: "Unknown device." });

  const headingNum = Number(body.heading);
  await db.upsertPresence({
    deviceId,
    displayName: user.displayName,
    lat,
    lng,
    heading: Number.isFinite(headingNum) ? headingNum : null,
    // Incognito is enforced here, not by the client simply not calling this
    // route -- that way flipping the toggle back off doesn't need to wait
    // out a stale timeout, and flipping it on hides you the moment the next
    // heartbeat lands rather than up to PRESENCE_MAX_AGE_MS later.
    incognito: !!body.incognito,
    // Separate opt-out from incognito -- see VOICE_ENABLED_KEY on the
    // client. Defaults true when the field is missing/not a boolean so an
    // older client (before this field existed) still counts as reachable.
    voiceEnabled: body.voiceEnabled !== false,
    updatedAt: new Date().toISOString(),
  });
  sendJson(res, 200, { ok: true });
});

// Who else is online right now, optionally within a map viewport. Bounds
// are optional so a caller could ask for "everyone" (e.g. a future admin
// view), but the mobile app always sends the current visible region -- that
// single query naturally covers both "who's near me" (initial region,
// centered on the device) and "who's over there" (after panning/zooming
// elsewhere), per how this was scoped.
route("GET", "/api/presence", async ({ res, query }) => {
  const deviceId = (query.get("deviceId") || "").trim();
  if (!deviceId) return sendJson(res, 400, { error: "Missing deviceId." });

  const north = Number(query.get("north"));
  const south = Number(query.get("south"));
  const east = Number(query.get("east"));
  const west = Number(query.get("west"));
  const bounds = [north, south, east, west].every(Number.isFinite) ? { north, south, east, west } : null;

  const users = await db.queryPresence({
    excludeDeviceId: deviceId,
    bounds,
    maxAgeMs: PRESENCE_MAX_AGE_MS,
  });
  sendJson(res, 200, { users });
});

// ---- Live race challenges (head-to-head against a nearby player) ---------
//
// A live, real-time race against a specific other signed-in user, not the
// async ghost-racing every other mode in this app uses. Distance is fixed to
// one of RACE_DISTANCES (no predefined route/road needed) -- each racer's
// own GPS trace is measured as they drive, and whoever covers the target
// distance first wins, so this works on whatever road the two of you happen
// to be on rather than needing a shared pre-recorded segment.

route("POST", "/api/races", async ({ res, body }) => {
  const fromDeviceId = (body.fromDeviceId || "").trim();
  const toDeviceId = (body.toDeviceId || "").trim();
  const distanceKey = body.distanceKey;
  if (!fromDeviceId || !toDeviceId || !RACE_DISTANCES[distanceKey]) {
    return sendJson(res, 400, {
      error: `fromDeviceId, toDeviceId, and a valid distanceKey (${Object.keys(RACE_DISTANCES).join(", ")}) are required`,
    });
  }

  const state = await db.load();
  const fromUser = findUserByDevice(state, fromDeviceId);
  const toUser = findUserByDevice(state, toDeviceId);
  if (!fromUser) return sendJson(res, 400, { error: "Unknown deviceId; register the user first." });
  if (!toUser) return sendJson(res, 404, { error: "That player isn't available right now." });
  if (fromUser.id === toUser.id) return sendJson(res, 400, { error: "You can't race yourself." });

  const existing = state.races.find((r) => {
    normalizeRaceStatus(r);
    if (!["pending", "accepted"].includes(r.status)) return false;
    return (
      (r.fromUserId === fromUser.id && r.toUserId === toUser.id) ||
      (r.fromUserId === toUser.id && r.toUserId === fromUser.id)
    );
  });
  if (existing) {
    return sendJson(res, 409, { error: "There's already an open race with this player." });
  }

  const race = {
    id: db.id("race"),
    fromUserId: fromUser.id,
    toUserId: toUser.id,
    distanceKey,
    status: "pending",
    createdAt: new Date().toISOString(),
    respondedAt: null,
    raceStartAt: null,
    finishedAt: null,
    progress: {},
    results: {},
  };
  state.races.push(race);
  await db.save(state);
  sendJson(res, 201, raceSummary(state, race, fromUser.id));
});

// Brand-new incoming challenges for this user -- polled from Home so a race
// request from a nearby player can surface as a prompt no matter what screen
// they're on (as long as they're signed in and the app is open).
route("GET", "/api/races/incoming", async ({ res, query }) => {
  const deviceId = (query.get("deviceId") || "").trim();
  if (!deviceId) return sendJson(res, 400, { error: "Missing deviceId." });
  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  if (!me) return sendJson(res, 404, { error: "User not found" });

  let changed = false;
  const incoming = state.races.filter((r) => {
    const before = r.status;
    normalizeRaceStatus(r);
    if (r.status !== before) changed = true;
    return r.toUserId === me.id && r.status === "pending";
  });
  if (changed) await db.save(state);
  sendJson(
    res,
    200,
    incoming.map((r) => raceSummary(state, r, me.id))
  );
});

route("GET", "/api/races/:id", async ({ res, params, query }) => {
  const deviceId = (query.get("deviceId") || "").trim();
  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  if (!me) return sendJson(res, 404, { error: "User not found" });

  const race = state.races.find((r) => r.id === params.id);
  if (!race || (race.fromUserId !== me.id && race.toUserId !== me.id)) {
    return sendJson(res, 404, { error: "Race not found" });
  }
  const before = race.status;
  normalizeRaceStatus(race);
  if (race.status !== before) await db.save(state);
  sendJson(res, 200, raceSummary(state, race, me.id));
});

route("POST", "/api/races/:id/respond", async ({ res, params, body }) => {
  const deviceId = (body.deviceId || "").trim();
  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  if (!me) return sendJson(res, 400, { error: "Unknown deviceId." });

  const race = state.races.find((r) => r.id === params.id);
  if (!race || (race.fromUserId !== me.id && race.toUserId !== me.id)) {
    return sendJson(res, 404, { error: "Race not found" });
  }
  if (race.toUserId !== me.id) {
    return sendJson(res, 403, { error: "Only the challenged player can respond to this." });
  }
  normalizeRaceStatus(race);
  if (race.status !== "pending") {
    return sendJson(res, 409, { error: "This race request is no longer available." });
  }

  race.respondedAt = new Date().toISOString();
  if (body.accept) {
    race.status = "accepted";
    race.raceStartAt = new Date(Date.now() + RACE_COUNTDOWN_MS).toISOString();
  } else {
    race.status = "declined";
  }
  await db.save(state);
  sendJson(res, 200, raceSummary(state, race, me.id));
});

// Live progress update during a race (posted every couple of seconds by
// both racers) -- also doubles as the poll for the opponent's latest
// progress, since the response is the same raceSummary either side would
// get from GET /api/races/:id, saving a round trip during the race itself.
route("POST", "/api/races/:id/progress", async ({ res, params, body }) => {
  const deviceId = (body.deviceId || "").trim();
  const distanceM = Number(body.distanceM);
  const elapsedMs = Number(body.elapsedMs);
  const speedKmh = Number(body.speedKmh);
  if (!Number.isFinite(distanceM) || !Number.isFinite(elapsedMs)) {
    return sendJson(res, 400, { error: "distanceM and elapsedMs are required" });
  }

  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  if (!me) return sendJson(res, 400, { error: "Unknown deviceId." });

  const race = state.races.find((r) => r.id === params.id);
  if (!race || (race.fromUserId !== me.id && race.toUserId !== me.id)) {
    return sendJson(res, 404, { error: "Race not found" });
  }
  if (race.status !== "accepted") {
    return sendJson(res, 409, { error: "This race isn't currently active." });
  }

  race.progress[me.id] = {
    distanceM: Math.max(0, distanceM),
    elapsedMs: Math.max(0, elapsedMs),
    speedKmh: Number.isFinite(speedKmh) ? Math.max(0, speedKmh) : 0,
    updatedAt: new Date().toISOString(),
  };
  await db.save(state);
  sendJson(res, 200, raceSummary(state, race, me.id));
});

route("POST", "/api/races/:id/finish", async ({ res, params, body }) => {
  const deviceId = (body.deviceId || "").trim();
  const durationMs = Number(body.durationMs);
  const distanceM = Number(body.distanceM);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return sendJson(res, 400, { error: "A valid durationMs is required" });
  }

  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  if (!me) return sendJson(res, 400, { error: "Unknown deviceId." });

  const race = state.races.find((r) => r.id === params.id);
  if (!race || (race.fromUserId !== me.id && race.toUserId !== me.id)) {
    return sendJson(res, 404, { error: "Race not found" });
  }
  if (race.status !== "accepted") {
    return sendJson(res, 409, { error: "This race isn't currently active." });
  }

  const rawMaxSpeed = Number(body.maxSpeedKmh);
  const rawAvgSpeed = Number(body.avgSpeedKmh);
  race.results[me.id] = {
    durationMs,
    distanceM: Number.isFinite(distanceM) ? distanceM : null,
    avgSpeedKmh: Number.isFinite(rawAvgSpeed) ? Math.round(rawAvgSpeed * 10) / 10 : 0,
    maxSpeedKmh: Number.isFinite(rawMaxSpeed) ? Math.round(Math.min(rawMaxSpeed, 350) * 10) / 10 : 0,
    finishedAt: new Date().toISOString(),
  };

  if (race.results[race.fromUserId] && race.results[race.toUserId]) {
    race.status = "finished";
    race.finishedAt = new Date().toISOString();
  }
  await db.save(state);
  sendJson(res, 200, raceSummary(state, race, me.id));
});

// Either racer can always bail -- a request still pending, or a race
// already under way. There's no penalty tracked for this; it's the safety
// valve that matters (never trap someone into finishing a race they don't
// want to keep driving).
route("POST", "/api/races/:id/cancel", async ({ res, params, body }) => {
  const deviceId = (body.deviceId || "").trim();
  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  if (!me) return sendJson(res, 400, { error: "Unknown deviceId." });

  const race = state.races.find((r) => r.id === params.id);
  if (!race || (race.fromUserId !== me.id && race.toUserId !== me.id)) {
    return sendJson(res, 404, { error: "Race not found" });
  }
  if (["pending", "accepted"].includes(race.status)) {
    race.status = "cancelled";
    race.finishedAt = new Date().toISOString();
  }
  await db.save(state);
  sendJson(res, 200, raceSummary(state, race, me.id));
});

// ---- Proximity voice (real-time audio with whoever's nearby) ----------
//
// The server never touches audio -- it only (a) tells a device who's
// currently in range and voice-eligible, and (b) relays the WebRTC
// signaling messages (SDP offers/answers, ICE candidates) the two devices
// need to negotiate a direct peer-to-peer audio connection with each other.
// Mirrors the race-challenge pattern of addressing everything by deviceId.

route("GET", "/api/voice/nearby", async ({ res, query }) => {
  const deviceId = (query.get("deviceId") || "").trim();
  const lat = Number(query.get("lat"));
  const lng = Number(query.get("lng"));
  if (!deviceId) return sendJson(res, 400, { error: "Missing deviceId." });
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return sendJson(res, 400, { error: "Missing or invalid lat/lng." });
  }

  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  if (!me) return sendJson(res, 404, { error: "User not found" });

  // No bounds -- everyone currently online and voice-eligible, then
  // filtered to the tight VOICE_RADIUS_M below. A map-viewport style query
  // doesn't make sense here since proximity voice cares about real-world
  // distance from the caller, not what's currently on their screen.
  const online = await db.queryPresence({
    excludeDeviceId: deviceId,
    bounds: null,
    maxAgeMs: PRESENCE_MAX_AGE_MS,
    requireVoiceEnabled: true,
  });

  const peers = online
    .filter((record) => geo.haversine({ lat, lng }, { lat: record.lat, lng: record.lng }) <= VOICE_RADIUS_M)
    .map((record) => {
      const otherUser = findUserByDevice(state, record.deviceId);
      return otherUser ? { deviceId: record.deviceId, displayName: otherUser.displayName, userId: otherUser.id } : null;
    })
    .filter((peer) => peer && !isBlockedPair(state, me.id, peer.userId))
    .map(({ deviceId, displayName }) => ({ deviceId, displayName }));

  sendJson(res, 200, { peers });
});

// Relays one signaling message. `data` is opaque here -- whatever shape the
// client's WebRTC layer produces (an SDP blob for offer/answer, a candidate
// object for ice), the server just stores and forwards it untouched.
route("POST", "/api/voice/signal", async ({ res, body }) => {
  const fromDeviceId = (body.fromDeviceId || "").trim();
  const toDeviceId = (body.toDeviceId || "").trim();
  const kind = body.kind;
  if (!fromDeviceId || !toDeviceId || !["offer", "answer", "ice"].includes(kind)) {
    return sendJson(res, 400, { error: "fromDeviceId, toDeviceId, and a valid kind (offer, answer, ice) are required" });
  }

  const state = await db.load();
  const from = findUserByDevice(state, fromDeviceId);
  const to = findUserByDevice(state, toDeviceId);
  if (!from) return sendJson(res, 400, { error: "Unknown deviceId; register the user first." });
  if (!to) return sendJson(res, 404, { error: "That player isn't available right now." });
  if (isBlockedPair(state, from.id, to.id)) {
    return sendJson(res, 403, { error: "That player isn't available right now." });
  }

  await db.pushVoiceSignal({
    id: db.id("vsig"),
    toDeviceId,
    fromDeviceId,
    fromDisplayName: from.displayName,
    kind,
    data: body.data,
    createdAt: new Date().toISOString(),
  });
  sendJson(res, 200, { ok: true });
});

// Drains (returns + deletes) every signal currently waiting for this
// device. Meant to be polled frequently (every second or two) only while
// there's an active call to set up or tear down -- not on a steady
// background cadence the way presence/incoming-races are.
route("GET", "/api/voice/signal", async ({ res, query }) => {
  const deviceId = (query.get("deviceId") || "").trim();
  if (!deviceId) return sendJson(res, 400, { error: "Missing deviceId." });
  const signals = await db.drainVoiceSignals(deviceId);
  sendJson(
    res,
    200,
    {
      signals: signals.map((s) => ({
        id: s.id,
        fromDeviceId: s.fromDeviceId,
        fromDisplayName: s.fromDisplayName,
        kind: s.kind,
        data: s.data,
      })),
    }
  );
});

route("POST", "/api/voice/block", async ({ res, body }) => {
  const deviceId = (body.deviceId || "").trim();
  const blockedDeviceId = (body.blockedDeviceId || "").trim();
  if (!deviceId || !blockedDeviceId) {
    return sendJson(res, 400, { error: "deviceId and blockedDeviceId are required" });
  }

  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  const target = findUserByDevice(state, blockedDeviceId);
  if (!me) return sendJson(res, 400, { error: "Unknown deviceId." });
  if (!target) return sendJson(res, 404, { error: "That player isn't available right now." });
  if (me.id === target.id) return sendJson(res, 400, { error: "You can't block yourself." });

  if (!isBlockedPair(state, me.id, target.id)) {
    state.blocks.push({
      id: db.id("blk"),
      blockerUserId: me.id,
      blockedUserId: target.id,
      createdAt: new Date().toISOString(),
    });
    await db.save(state);
  }
  sendJson(res, 200, { ok: true });
});

// Only the person who placed a block can lift it -- unblocking removes just
// the (blocker -> blocked) row, so if both sides had somehow blocked each
// other, each still needs to unblock on their own side.
route("POST", "/api/voice/unblock", async ({ res, body }) => {
  const deviceId = (body.deviceId || "").trim();
  const blockedDeviceId = (body.blockedDeviceId || "").trim();
  if (!deviceId || !blockedDeviceId) {
    return sendJson(res, 400, { error: "deviceId and blockedDeviceId are required" });
  }

  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  const target = findUserByDevice(state, blockedDeviceId);
  if (!me) return sendJson(res, 400, { error: "Unknown deviceId." });
  if (!target) return sendJson(res, 404, { error: "That player isn't available right now." });

  const before = state.blocks.length;
  state.blocks = state.blocks.filter((b) => !(b.blockerUserId === me.id && b.blockedUserId === target.id));
  if (state.blocks.length !== before) {
    await db.save(state);
  }
  sendJson(res, 200, { ok: true });
});

route("GET", "/api/voice/blocked", async ({ res, query }) => {
  const deviceId = (query.get("deviceId") || "").trim();
  if (!deviceId) return sendJson(res, 400, { error: "Missing deviceId." });

  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  if (!me) return sendJson(res, 400, { error: "Unknown deviceId." });

  const blocked = state.blocks
    .filter((b) => b.blockerUserId === me.id)
    .map((b) => {
      const target = state.users.find((u) => u.id === b.blockedUserId);
      return target ? { deviceId: target.deviceId, displayName: target.displayName } : null;
    })
    .filter(Boolean);

  sendJson(res, 200, { blocked });
});

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }
  dispatch(req, res).catch((err) => {
    sendJson(res, 500, { error: err.message || "Internal error" });
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Need-for-Speed backend listening on http://localhost:${PORT}`);
  });
}

module.exports = server;
