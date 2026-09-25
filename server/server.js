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
// Which way the race is run. Both racers agree on one compass direction up
// front, and each one's progress counts only how far they get in that
// direction (see the client's projection math) -- so a head-to-head race is
// actually the same race for both, and driving the opposite way doesn't
// score. Mirrored client-side in mobile/src/raceDirections.ts.
const RACE_DIRECTIONS = {
  north: { label: "NORTH", bearing: 0 },
  east: { label: "EAST", bearing: 90 },
  south: { label: "SOUTH", bearing: 180 },
  west: { label: "WEST", bearing: 270 },
};
const DEFAULT_RACE_DIRECTION = "north";

const RACE_REQUEST_TIMEOUT_MS = 45000;
// An accepted race that's gone quiet this long -- no progress posted, no
// finish, no cancel -- is treated as abandoned. Without this an accepted
// race stayed open forever if either phone was closed mid-race, and the
// pair could never challenge each other again ("There's already an open
// race with this player"), with no way out from inside the app.
const RACE_ABANDON_TIMEOUT_MS = 15 * 60 * 1000;
// Gap between "accepted" and the actual start, so both phones can count down
// from the same server-issued timestamp rather than starting the instant
// each individual device happens to receive the accept.
// Long enough for the challenger's phone to notice the accept (it polls
// every 1.5s), open the race and sync its clock to the server's before GO.
const RACE_COUNTDOWN_MS = 8000;

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

// ---- Racer names: one per person -------------------------------------------
//
// Names are unique ignoring case, extra/odd whitespace and Unicode lookalike
// forms (NFKC folds e.g. full-width "Ｒacer" into "Racer"), so near-copies
// like "racer", "Racer " or "Racer  X" vs "Racer X" can't be registered
// alongside an existing name.
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 24;

function normalizeName(raw) {
  return String(raw || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width characters
    .replace(/\s+/g, " ")
    .trim();
}

function nameKey(raw) {
  return normalizeName(raw).toLowerCase();
}

// Returns an error message if the name is unusable, else null.
function validateName(name) {
  if (!name) return "Pick a racer name.";
  if (name.length < NAME_MIN_LENGTH) return `Racer names need at least ${NAME_MIN_LENGTH} characters.`;
  if (name.length > NAME_MAX_LENGTH) return `Racer names can be at most ${NAME_MAX_LENGTH} characters.`;
  return null;
}

// Every account whose name matches. Normally 0 or 1 -- more only for
// duplicates created before names were enforced unique.
function findUsersByName(dbState, displayName) {
  const key = nameKey(displayName);
  return dbState.users.filter((u) => nameKey(u.displayName) === key);
}

function findUserByName(dbState, displayName) {
  return findUsersByName(dbState, displayName)[0];
}

// Serializes account-changing requests (sign-up, rename). Every route reads
// the whole state, changes it and saves it back, so two sign-ups for the
// same name arriving at the same moment could otherwise both pass the
// "is it taken?" check before either saves. The backend is a single Node
// process, so an in-process queue is enough.
let accountQueue = Promise.resolve();
function withAccountLock(fn) {
  const run = accountQueue.then(fn, fn);
  accountQueue = run.catch(() => {});
  return run;
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

// Nothing on a public road gets past this, so anything above it is a GPS
// glitch rather than a drive -- used to clamp every speed the app reports
// (runs, trips, races and the passive top-speed tracker alike) so one bad
// fix can't park itself at the top of the leaderboard forever.
const MAX_PLAUSIBLE_SPEED_KMH = 350;

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
  if (race.status === "accepted" && Date.now() - lastRaceActivityMs(race) > RACE_ABANDON_TIMEOUT_MS) {
    race.status = "expired";
  }
  return race;
}

// The most recent sign of life on a race: when it started, either racer's
// last progress ping, or either racer's finish.
function lastRaceActivityMs(race) {
  const times = [race.raceStartAt, race.respondedAt, race.createdAt];
  for (const p of Object.values(race.progress || {})) times.push(p.updatedAt);
  for (const r of Object.values(race.results || {})) times.push(r.finishedAt);
  let newest = 0;
  for (const t of times) {
    const ms = t ? new Date(t).getTime() : 0;
    if (Number.isFinite(ms) && ms > newest) newest = ms;
  }
  return newest;
}

// A point `distanceM` away from `start` along a compass bearing. Flat-earth
// maths, which is plenty at race distances (a few km at most).
function destinationPoint(start, bearingDeg, distanceM) {
  const rad = (bearingDeg * Math.PI) / 180;
  const METERS_PER_DEG_LAT = 111320;
  return {
    lat: start.lat + (Math.cos(rad) * distanceM) / METERS_PER_DEG_LAT,
    lng:
      start.lng +
      (Math.sin(rad) * distanceM) / (METERS_PER_DEG_LAT * Math.cos((start.lat * Math.PI) / 180)),
  };
}

// Cuts a route down to exactly `targetM` of road, interpolating the last
// point so the course ends on the line rather than at whatever vertex came
// after it. Roads wind, so a route to a point `targetM` away as the crow
// flies is always at least that long -- the leftover is what gets cut.
function truncatePolyline(points, targetM) {
  if (!Array.isArray(points) || points.length < 2) return { points: points || [], distanceM: 0 };
  const out = [points[0]];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const segM = geo.haversine(points[i - 1], points[i]);
    if (total + segM >= targetM && segM > 0) {
      const f = (targetM - total) / segM;
      out.push({
        lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * f,
        lng: points[i - 1].lng + (points[i].lng - points[i - 1].lng) * f,
      });
      return { points: out, distanceM: targetM };
    }
    total += segM;
    out.push(points[i]);
  }
  return { points: out, distanceM: total };
}

// The actual road both racers drive: a real driving route from where they
// are, heading the way they picked, cut to exactly the distance they picked.
// Built once when the challenge is accepted and stored on the race, so both
// phones draw and are scored against the same course. Best-effort -- if
// routing isn't configured or Google can't find a road that way, the race
// simply runs without a course and falls back to measuring progress along
// the compass axis (see raceDirections.ts on the client).
async function buildRaceCourse(start, bearingDeg, targetM) {
  const straightDest = destinationPoint(start, bearingDeg, targetM);
  const route = await requestDrivingRoute(start, straightDest);
  const cut = truncatePolyline(route.points, targetM);
  if (cut.points.length < 2 || cut.distanceM < targetM * 0.5) return null;
  return {
    points: cut.points,
    distanceM: Math.round(cut.distanceM),
    createdAt: new Date().toISOString(),
  };
}

// A finished racer's own side of a race, normalized for the client.
// `completed` (did they actually cover the target distance, rather than
// finishing early by hand) and `forfeited` (they gave up, so the other side
// wins whatever the clock says) are what the result screen ranks on --
// duration alone can't, since quitting after ten seconds would otherwise
// post the fastest time. Results recorded before these flags existed are
// treated as a normal completed finish, which is what they were.
function raceResultView(race, result) {
  if (!result) return null;
  const dist = RACE_DISTANCES[race.distanceKey];
  const target = dist ? dist.meters : race.distanceM || 0;
  const completed =
    typeof result.completed === "boolean"
      ? result.completed
      : !Number.isFinite(result.distanceM) || target <= 0
      ? true
      : result.distanceM >= target * 0.99;
  return {
    durationMs: result.durationMs,
    distanceM: Number.isFinite(result.distanceM) ? result.distanceM : null,
    avgSpeedKmh: result.avgSpeedKmh ?? 0,
    maxSpeedKmh: result.maxSpeedKmh ?? 0,
    finishedAt: result.finishedAt,
    completed,
    forfeited: !!result.forfeited,
  };
}

// Client-facing view of a race challenge, from one specific viewer's side --
// "my" vs "opponent" rather than "from" vs "to", so the same shape works
// whether the viewer sent or received the challenge, and the client never
// has to juggle which field is which.
function raceSummary(dbState, race, viewerUserId, { includeCourse = false } = {}) {
  const opponentId = race.fromUserId === viewerUserId ? race.toUserId : race.fromUserId;
  const fromUser = dbState.users.find((u) => u.id === race.fromUserId);
  const toUser = dbState.users.find((u) => u.id === race.toUserId);
  const opponentUser = dbState.users.find((u) => u.id === opponentId);
  const dist = RACE_DISTANCES[race.distanceKey];
  // Races created before directions existed have none -- treat them as
  // north so old records still render instead of breaking the screen.
  const dirKey = RACE_DIRECTIONS[race.directionKey] ? race.directionKey : DEFAULT_RACE_DIRECTION;
  const dir = RACE_DIRECTIONS[dirKey];
  return {
    id: race.id,
    distanceKey: race.distanceKey,
    distanceM: dist ? dist.meters : race.distanceM,
    distanceLabel: dist ? dist.label : "",
    directionKey: dirKey,
    directionLabel: dir.label,
    directionBearing: dir.bearing,
    status: race.status,
    createdAt: race.createdAt,
    raceStartAt: race.raceStartAt || null,
    isChallenger: race.fromUserId === viewerUserId,
    fromDisplayName: fromUser?.displayName ?? "Unknown",
    toDisplayName: toUser?.displayName ?? "Unknown",
    opponentDisplayName: opponentUser?.displayName ?? "Unknown",
    myProgress: race.progress?.[viewerUserId] ?? null,
    opponentProgress: race.progress?.[opponentId] ?? null,
    // The course is only sent where it's needed (loading the race screen).
    // Progress polling returns this same summary every couple of seconds,
    // and a road route is far too big to re-send on every tick.
    courseDistanceM: race.course ? race.course.distanceM : null,
    course: includeCourse && race.course ? race.course.points : null,
    myResult: raceResultView(race, race.results?.[viewerUserId]),
    opponentResult: raceResultView(race, race.results?.[opponentId]),
    // Lets each phone measure how far its own clock is from this one, so
    // both count down to raceStartAt on the same clock.
    serverNow: Date.now(),
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
  const name = normalizeName(body.displayName);
  const password = body.password || "";
  const nameError = validateName(name);
  if (nameError) return sendJson(res, 400, { error: nameError });
  if (password.length < 4) return sendJson(res, 400, { error: "Password must be at least 4 characters." });

  await withAccountLock(async () => {
    const state = await db.load();
    const matches = findUsersByName(state, name);

    let user;
    if (matches.some((u) => u.passwordHash) || matches.length > 1) {
      return sendJson(res, 409, { error: "That name is already taken. Try logging in, or pick a different name." });
    } else if (matches.length === 1) {
      // A pre-accounts record with no password yet -- claim it (keeps its
      // history). Only when it's the one and only record with that name.
      user = matches[0];
      user.passwordHash = hashPassword(password);
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
});

// Live "is this name free?" check for the sign-up and rename forms, so you
// find out while typing instead of after submitting. Pass deviceId when
// renaming so your own current name counts as available to you. The real
// guarantee is still the check inside register/rename; this is just UX.
route("GET", "/api/users/name-available", async ({ res, query }) => {
  const name = normalizeName(query.get("name"));
  const nameError = validateName(name);
  if (nameError) return sendJson(res, 200, { available: false, reason: nameError, name });
  const state = await db.load();
  const deviceId = query.get("deviceId");
  const me = deviceId ? findUserByDevice(state, deviceId) : null;
  const others = findUsersByName(state, name).filter((u) => !me || u.id !== me.id);
  sendJson(res, 200, {
    available: others.length === 0,
    reason: others.length === 0 ? null : "That name is already taken.",
    name,
  });
});

// Log in from any device with a racer name + password, to pick up that
// account's saved name and leaderboard history here.
route("POST", "/api/auth/login", async ({ res, body }) => {
  const name = normalizeName(body.displayName);
  const password = body.password || "";
  if (!name || !password) return sendJson(res, 400, { error: "Name and password are required." });

  const state = await db.load();
  // Checks every account with this name (old duplicates can exist from
  // before names were unique), so each one still logs into its own account.
  const user = findUsersByName(state, name).find((u) => verifyPassword(password, u.passwordHash));
  if (!user) {
    return sendJson(res, 401, { error: "Incorrect name or password." });
  }
  sendJson(res, 200, publicUser(user));
});

// Rename an already-signed-in account. No password needed -- you're
// already authenticated by having this device's saved account.
route("PATCH", "/api/users/:deviceId", async ({ res, params, body }) => {
  const name = normalizeName(body.displayName);
  const nameError = validateName(name);
  if (nameError) return sendJson(res, 400, { error: nameError });

  await withAccountLock(async () => {
    const state = await db.load();
    const user = findUserByDevice(state, params.deviceId);
    if (!user) return sendJson(res, 404, { error: "User not found." });

    const clash = findUsersByName(state, name).some((u) => u.id !== user.id);
    if (clash) {
      return sendJson(res, 409, { error: "That name is already taken." });
    }

    user.displayName = name;
    await db.save(state);
    sendJson(res, 200, publicUser(user));
  });
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

// Your fastest speed ever seen by the app, including while you weren't
// recording anything -- the phone reports a new personal best as it happens
// (see topSpeed.ts on the client) and this keeps the highest one. Stored on
// the account, so it follows you to a new phone like everything else.
route("POST", "/api/users/:deviceId/top-speed", async ({ res, params, body }) => {
  const speedKmh = Number(body.speedKmh);
  if (!Number.isFinite(speedKmh) || speedKmh <= 0) {
    return sendJson(res, 400, { error: "A valid speedKmh is required" });
  }
  if (speedKmh > MAX_PLAUSIBLE_SPEED_KMH) {
    // Not an error worth surfacing on the phone -- just refuse to store it.
    const state = await db.load();
    const user = findUserByDevice(state, params.deviceId);
    if (!user) return sendJson(res, 404, { error: "User not found" });
    return sendJson(res, 200, { topSpeedKmh: user.topSpeedKmh ?? 0, topSpeedAt: user.topSpeedAt ?? null });
  }

  const state = await db.load();
  const user = findUserByDevice(state, params.deviceId);
  if (!user) return sendJson(res, 404, { error: "User not found" });

  const rounded = Math.round(speedKmh * 10) / 10;
  if (rounded > (user.topSpeedKmh ?? 0)) {
    user.topSpeedKmh = rounded;
    user.topSpeedAt = new Date().toISOString();
    await db.save(state);
  }
  sendJson(res, 200, { topSpeedKmh: user.topSpeedKmh ?? 0, topSpeedAt: user.topSpeedAt ?? null });
});

route("GET", "/api/users/:deviceId/top-speed", async ({ res, params }) => {
  const state = await db.load();
  const user = findUserByDevice(state, params.deviceId);
  if (!user) return sendJson(res, 404, { error: "User not found" });
  sendJson(res, 200, { topSpeedKmh: user.topSpeedKmh ?? 0, topSpeedAt: user.topSpeedAt ?? null });
});

// Finished live races, newest first -- the third source of drive stats
// alongside segment runs and Go To trips. A forfeited race still appears:
// you drove that distance, it just didn't win.
route("GET", "/api/users/:deviceId/races", async ({ res, params }) => {
  const state = await db.load();
  const user = findUserByDevice(state, params.deviceId);
  if (!user) return sendJson(res, 404, { error: "User not found" });

  const entries = (state.races || [])
    .filter((r) => r.status === "finished" && r.results?.[user.id])
    .map((r) => {
      const opponentId = r.fromUserId === user.id ? r.toUserId : r.fromUserId;
      const mine = raceResultView(r, r.results[user.id]);
      const theirs = raceResultView(r, r.results?.[opponentId]);
      const dist = RACE_DISTANCES[r.distanceKey];
      const dirKey = RACE_DIRECTIONS[r.directionKey] ? r.directionKey : DEFAULT_RACE_DIRECTION;
      return {
        raceId: r.id,
        opponentDisplayName: state.users.find((u) => u.id === opponentId)?.displayName ?? "Unknown",
        distanceLabel: dist ? dist.label : "",
        directionLabel: RACE_DIRECTIONS[dirKey].label,
        durationMs: mine.durationMs,
        distanceM: mine.distanceM ?? 0,
        avgSpeedKmh: mine.avgSpeedKmh,
        maxSpeedKmh: mine.maxSpeedKmh,
        forfeited: mine.forfeited,
        won: theirs ? raceWinnerIsMine(mine, theirs) : null,
        recordedAt: mine.finishedAt || r.finishedAt,
      };
    })
    .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));
  sendJson(res, 200, entries);
});

// Who took it, given both sides' results: giving up loses outright, then
// actually covering the distance beats stopping short, and only after that
// does the clock decide. null means a dead heat.
function raceWinnerIsMine(mine, theirs) {
  const rank = (r) => (r.forfeited ? 2 : r.completed ? 0 : 1);
  const a = rank(mine);
  const b = rank(theirs);
  if (a !== b) return a < b;
  if (a === 0) {
    if (mine.durationMs === theirs.durationMs) return null;
    return mine.durationMs < theirs.durationMs;
  }
  const myDist = mine.distanceM ?? 0;
  const theirDist = theirs.distanceM ?? 0;
  if (myDist === theirDist) return null;
  return myDist > theirDist;
}

// Delete an account and everything tied to it. Password-confirmed, since
// deviceId alone travels in URLs. Public tracks this racer created are kept
// -- other people race them and they're part of the map -- but every run,
// trip, race, block and private track of theirs goes. Their presence record
// is left to go stale on its own (25s) rather than reaching into the
// separate presence store. Also what app stores require an account-holder
// to be able to do.
route("POST", "/api/users/:deviceId/delete", async ({ res, params, body }) => {
  const state = await db.load();
  const user = findUserByDevice(state, params.deviceId);
  if (!user) return sendJson(res, 404, { error: "User not found" });
  if (user.passwordHash && !verifyPassword(body.password || "", user.passwordHash)) {
    return sendJson(res, 401, { error: "Wrong password." });
  }

  const removed = {
    runs: 0,
    trips: 0,
    races: 0,
    soloRuns: 0,
    blocks: 0,
    privateSegments: 0,
    keptPublicSegments: 0,
  };

  state.runs = (state.runs || []).filter((r) => {
    if (r.userId !== user.id) return true;
    removed.runs += 1;
    return false;
  });
  state.trips = (state.trips || []).filter((t) => {
    if (t.userId !== user.id) return true;
    removed.trips += 1;
    return false;
  });
  state.races = (state.races || []).filter((r) => {
    if (r.fromUserId !== user.id && r.toUserId !== user.id) return true;
    removed.races += 1;
    return false;
  });
  state.soloRuns = (state.soloRuns || []).filter((r) => {
    if (r.userId !== user.id) return true;
    removed.soloRuns += 1;
    return false;
  });
  state.blocks = (state.blocks || []).filter((b) => {
    if (b.blockerUserId !== user.id && b.blockedUserId !== user.id) return true;
    removed.blocks += 1;
    return false;
  });
  state.segments = (state.segments || []).filter((s) => {
    if (s.creatorId !== user.id) return true;
    if (s.isPrivate) {
      removed.privateSegments += 1;
      return false;
    }
    removed.keptPublicSegments += 1;
    return true;
  });
  // Any runs other people set on a kept track are untouched; the deleted
  // racer's own runs are gone, so leaderboards and best times recompute
  // themselves from what's left.
  state.users = state.users.filter((u) => u.id !== user.id);

  await db.save(state);
  sendJson(res, 200, { deleted: true, displayName: user.displayName, removed });
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
// One driving route between two points, straight from Google. Shared by
// the "Go To a place" route below and by race-course building, so there's
// one place that knows the request shape and the failure cases.
async function requestDrivingRoute(origin, destination) {
  if (!GOOGLE_SERVER_API_KEY) throw new Error("Routing isn't configured on the server yet.");
  const url =
    `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.lat},${origin.lng}` +
    `&destination=${destination.lat},${destination.lng}&mode=driving&key=${GOOGLE_SERVER_API_KEY}`;
  const data = await httpsGetJson(url);
  if (data.status !== "OK" || !data.routes || !data.routes.length) {
    const err = new Error(data.error_message || `No route found (${data.status})`);
    err.noRoute = true;
    throw err;
  }
  const route0 = data.routes[0];
  const leg = route0.legs[0];
  return {
    points: geo.decodePolyline(route0.overview_polyline.points),
    distanceM: leg.distance.value,
    durationS: leg.duration.value,
    durationInTrafficS: leg.duration_in_traffic ? leg.duration_in_traffic.value : null,
    endAddress: leg.end_address,
  };
}

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
    const route = await requestDrivingRoute(
      { lat: originLat, lng: originLng },
      { lat: destLat, lng: destLng }
    );
    sendJson(res, 200, route);
  } catch (e) {
    if (e.noRoute) return sendJson(res, 422, { error: e.message });
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

// ---- Worldwide stats leaderboard ------------------------------------------
//
// Everyone's lifetime numbers, same definitions as the personal Stats screen
// (segment runs + Go To trips + finished live races combined, plus the
// passive top speed for the speed board; average speed distance-weighted =
// total distance / total time), ranked by one metric at a time. Returns the
// top GLOBAL_STATS_LIMIT plus the caller's own entry and rank, so you can
// see where you stand even when you're not in the top list.
const GLOBAL_STATS_LIMIT = 50;
// Average speed is only ranked for racers with at least this much driving,
// so a single 100m sprint can't top the table on its own.
const GLOBAL_AVG_MIN_DISTANCE_M = 1000;
const GLOBAL_STATS_METRICS = ["topSpeed", "distance", "avgSpeed", "wins", "soloQuarter", "soloMile", "soloFive"];
// Fastest-time boards: best completed solo run per racer at one distance.
const SOLO_METRIC_DISTANCE = { soloQuarter: "quarter", soloMile: "mile", soloFive: "five" };

function computeGlobalStats(state) {
  const byUser = new Map();
  const add = (userId, distanceM, durationMs, maxSpeedKmh) => {
    let s = byUser.get(userId);
    if (!s) {
      s = { distanceM: 0, durationMs: 0, topSpeedKmh: 0, driveCount: 0, raceCount: 0, raceWins: 0, soloBestMs: {} };
      byUser.set(userId, s);
    }
    if (Number.isFinite(distanceM) && distanceM > 0) s.distanceM += distanceM;
    if (Number.isFinite(durationMs) && durationMs > 0) s.durationMs += durationMs;
    if (Number.isFinite(maxSpeedKmh) && maxSpeedKmh > s.topSpeedKmh) s.topSpeedKmh = maxSpeedKmh;
    s.driveCount += 1;
  };
  for (const r of state.runs || []) {
    add(r.userId, geo.polylineLength(r.trace || []), r.durationMs, r.maxSpeedKmh ?? 0);
  }
  for (const t of state.trips || []) {
    add(t.userId, t.distanceM, t.durationMs, t.maxSpeedKmh ?? 0);
  }
  // Live head-to-head races count too -- including forfeited ones, since
  // the driving happened either way -- and each one's winner picks up a win.
  const ensure = (userId) => {
    let s = byUser.get(userId);
    if (!s) {
      s = { distanceM: 0, durationMs: 0, topSpeedKmh: 0, driveCount: 0, raceCount: 0, raceWins: 0, soloBestMs: {} };
      byUser.set(userId, s);
    }
    return s;
  };
  for (const race of state.races || []) {
    if (race.status !== "finished") continue;
    for (const userId of [race.fromUserId, race.toUserId]) {
      const result = raceResultView(race, race.results?.[userId]);
      if (!result || !(result.durationMs > 0)) continue;
      if (isImplausibleRun(result.avgSpeedKmh, result.maxSpeedKmh)) continue;
      add(userId, result.distanceM ?? 0, result.durationMs, result.maxSpeedKmh);
    }
    const mine = raceResultView(race, race.results?.[race.fromUserId]);
    const theirs = raceResultView(race, race.results?.[race.toUserId]);
    if (!mine || !theirs) continue;
    ensure(race.fromUserId).raceCount += 1;
    ensure(race.toUserId).raceCount += 1;
    const fromWon = raceWinnerIsMine(mine, theirs);
    if (fromWon === true) ensure(race.fromUserId).raceWins += 1;
    else if (fromWon === false) ensure(race.toUserId).raceWins += 1;
  }

  // A personal best set while just driving around with the app open counts
  // for the top-speed board even with no recorded drive behind it -- it
  // only tops up topSpeedKmh, never distance/time/drive count, so it can't
  // affect the distance or average-speed boards.
  for (const user of state.users) {
    const passive = user.topSpeedKmh ?? 0;
    if (!(passive > 0)) continue;
    const s = ensure(user.id);
    if (passive > s.topSpeedKmh) s.topSpeedKmh = passive;
  }

  // Solo timed runs: the driving counts like any other drive, and each
  // racer's fastest completed time per distance feeds the time boards.
  for (const run of state.soloRuns || []) {
    if (run.status !== "finished" || !run.result || !(run.result.durationMs > 0)) continue;
    const r = run.result;
    if (isImplausibleRun(r.avgSpeedKmh, r.maxSpeedKmh)) continue;
    add(run.userId, r.distanceM ?? 0, r.durationMs, r.maxSpeedKmh);
    if (!r.completed) continue;
    const s = ensure(run.userId);
    const cur = s.soloBestMs[run.distanceKey];
    if (cur == null || r.durationMs < cur) s.soloBestMs[run.distanceKey] = r.durationMs;
  }

  const entries = [];
  for (const [userId, s] of byUser) {
    const user = state.users.find((u) => u.id === userId);
    if (!user) continue;
    entries.push({
      userId,
      displayName: user.displayName,
      topSpeedKmh: Math.round(s.topSpeedKmh * 10) / 10,
      distanceM: Math.round(s.distanceM),
      avgSpeedKmh: s.durationMs > 0 ? Math.round((s.distanceM / 1000 / (s.durationMs / 3_600_000)) * 10) / 10 : 0,
      driveCount: s.driveCount,
      raceCount: s.raceCount,
      raceWins: s.raceWins,
      soloQuarterMs: s.soloBestMs.quarter ?? null,
      soloMileMs: s.soloBestMs.mile ?? null,
      soloFiveMs: s.soloBestMs.five ?? null,
    });
  }
  return entries;
}

route("GET", "/api/stats/global", async ({ res, query }) => {
  const requested = query.get("metric");
  const metric = GLOBAL_STATS_METRICS.includes(requested) ? requested : "topSpeed";
  const deviceId = query.get("deviceId");
  const state = await db.load();
  const me = deviceId ? findUserByDevice(state, deviceId) : null;

  const soloKey = SOLO_METRIC_DISTANCE[metric];
  const valueOf = (e) =>
    soloKey
      ? e[`solo${soloKey[0].toUpperCase()}${soloKey.slice(1)}Ms`]
      : metric === "topSpeed"
      ? e.topSpeedKmh
      : metric === "distance"
      ? e.distanceM
      : metric === "wins"
      ? e.raceWins
      : e.avgSpeedKmh;
  // Times rank fastest (lowest) first; everything else highest first.
  const eligible = computeGlobalStats(state)
    .filter((e) => (metric === "avgSpeed" ? e.distanceM >= GLOBAL_AVG_MIN_DISTANCE_M : true))
    .filter((e) => valueOf(e) != null && valueOf(e) > 0)
    .sort((a, b) =>
      (soloKey ? valueOf(a) - valueOf(b) : valueOf(b) - valueOf(a)) || a.displayName.localeCompare(b.displayName)
    );

  const ranked = eligible.map((e, i) => {
    const { userId, ...rest } = e;
    return { rank: i + 1, isMe: !!me && userId === me.id, ...rest };
  });

  sendJson(res, 200, {
    metric,
    totalRacers: ranked.length,
    minDistanceM: metric === "avgSpeed" ? GLOBAL_AVG_MIN_DISTANCE_M : 0,
    leaderboard: ranked.slice(0, GLOBAL_STATS_LIMIT),
    me: ranked.find((e) => e.isMe) || null,
  });
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
  const directionKey = RACE_DIRECTIONS[body.directionKey] ? body.directionKey : DEFAULT_RACE_DIRECTION;

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
    directionKey,
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

// Loading the race screen -- the one place that gets the full course.
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
  // The race screen loads from here, so this is where the course has to
  // come back -- it's left out of the progress polls, not out of this.
  sendJson(res, 200, raceSummary(state, race, me.id, { includeCourse: true }));
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
    // Lay out the road course from where the accepting racer is standing --
    // the two of you are side by side, so either position gives the same
    // road. Failures are swallowed: no course just means the race is scored
    // on the compass axis as before, which is better than refusing to start.
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const dist = RACE_DISTANCES[race.distanceKey];
    const dirKey = RACE_DIRECTIONS[race.directionKey] ? race.directionKey : DEFAULT_RACE_DIRECTION;
    if (Number.isFinite(lat) && Number.isFinite(lng) && dist) {
      try {
        race.course = await buildRaceCourse({ lat, lng }, RACE_DIRECTIONS[dirKey].bearing, dist.meters);
      } catch (e) {
        race.course = null;
      }
    }
  } else {
    race.status = "declined";
  }
  await db.save(state);
  sendJson(res, 200, raceSummary(state, race, me.id, { includeCourse: true }));
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

// When a race ends, the racer who didn't post a result still gets one,
// banked from their last live progress -- nobody has to keep driving to
// collect a win, and nobody is left sitting on a race screen that will
// never end. Used by finish and by forfeit alike.
function bankProgressAsResult(race, userId) {
  if (race.results[userId]) return;
  const p = race.progress?.[userId];
  race.results[userId] = buildRaceResult({
    durationMs: p ? p.elapsedMs : 0,
    distanceM: p ? p.distanceM : 0,
    avgSpeedKmh: p && p.elapsedMs > 0 ? p.distanceM / 1000 / (p.elapsedMs / 3600000) : 0,
    maxSpeedKmh: p ? p.speedKmh : 0,
    completed: false,
    forfeited: false,
  });
}

// One racer's stored result. Speeds are clamped/validated here rather than
// at each call site so a finish, an early finish and a forfeit all record
// the same shape (which is what the stats totals and the result screen
// both read).
function buildRaceResult({ durationMs, distanceM, avgSpeedKmh, maxSpeedKmh, completed, forfeited }) {
  return {
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    distanceM: Number.isFinite(distanceM) ? Math.max(0, distanceM) : null,
    avgSpeedKmh: Number.isFinite(avgSpeedKmh) ? Math.round(Math.max(0, avgSpeedKmh) * 10) / 10 : 0,
    maxSpeedKmh: Number.isFinite(maxSpeedKmh)
      ? Math.round(Math.min(Math.max(0, maxSpeedKmh), MAX_PLAUSIBLE_SPEED_KMH) * 10) / 10
      : 0,
    finishedAt: new Date().toISOString(),
    completed: !!completed,
    forfeited: !!forfeited,
  };
}

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

  const dist = RACE_DISTANCES[race.distanceKey];
  const targetM = dist ? dist.meters : race.distanceM || 0;
  // Crossing the line is a finish; stopping anywhere short of it is a
  // forfeit -- ending the race by hand is never a way to win it. (Older app
  // builds had a FINISH NOW button that called this part-way down the road;
  // this keeps them honest too.)
  const completed = Number.isFinite(distanceM) ? distanceM >= targetM * 0.99 : true;
  race.results[me.id] = buildRaceResult({
    durationMs,
    distanceM,
    avgSpeedKmh: Number(body.avgSpeedKmh),
    maxSpeedKmh: Number(body.maxSpeedKmh),
    completed,
    forfeited: !completed,
  });

  // A race is over the moment someone crosses the line (or ends it by
  // hand): the other racer's progress is banked right there. Previously
  // they were left driving a race that had already been decided, with the
  // result screen waiting on a finish that might never come.
  const opponentId = race.fromUserId === me.id ? race.toUserId : race.fromUserId;
  bankProgressAsResult(race, opponentId);
  race.status = "finished";
  race.finishedAt = new Date().toISOString();
  await db.save(state);
  sendJson(res, 200, raceSummary(state, race, me.id));
});

// One racer giving up: the race ends immediately and the other side wins,
// whatever the clock says. Distinct from cancel (which voids the race for
// both of you and records nothing) -- this is the "I'm out, you take it"
// option, and the driving you did up to that point still counts toward your
// stats, the same way an abandoned Go To drive would if you saved it.
route("POST", "/api/races/:id/forfeit", async ({ res, params, body }) => {
  const deviceId = (body.deviceId || "").trim();
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

  const opponentId = race.fromUserId === me.id ? race.toUserId : race.fromUserId;
  race.results[me.id] = buildRaceResult({
    durationMs: Number(body.durationMs),
    distanceM: Number(body.distanceM),
    avgSpeedKmh: Number(body.avgSpeedKmh),
    maxSpeedKmh: Number(body.maxSpeedKmh),
    completed: false,
    forfeited: true,
  });
  bankProgressAsResult(race, opponentId);
  race.status = "finished";
  race.finishedAt = new Date().toISOString();
  await db.save(state);
  sendJson(res, 200, raceSummary(state, race, me.id));
});

// ---- Solo timed runs ------------------------------------------------------
//
// The same road course a head-to-head race gets (a real driving route from
// where you are, the way you picked, cut to exactly the distance), but just
// you against the clock. Finished runs are your personal bests per distance
// and feed the worldwide fastest-times boards.

function soloSummary(run, { includeCourse = false } = {}) {
  const dist = RACE_DISTANCES[run.distanceKey];
  const dirKey = RACE_DIRECTIONS[run.directionKey] ? run.directionKey : DEFAULT_RACE_DIRECTION;
  return {
    id: run.id,
    distanceKey: run.distanceKey,
    distanceM: dist ? dist.meters : 0,
    distanceLabel: dist ? dist.label : "",
    directionKey: dirKey,
    directionLabel: RACE_DIRECTIONS[dirKey].label,
    directionBearing: RACE_DIRECTIONS[dirKey].bearing,
    courseDistanceM: run.course ? run.course.distanceM : null,
    course: includeCourse && run.course ? run.course.points : null,
    status: run.status,
    createdAt: run.createdAt,
    result: run.result || null,
  };
}

// A user's fastest completed time at one distance, or null.
function bestSoloResult(state, userId, distanceKey, excludeRunId) {
  let best = null;
  for (const r of state.soloRuns || []) {
    if (r.userId !== userId || r.distanceKey !== distanceKey || r.id === excludeRunId) continue;
    if (r.status !== "finished" || !r.result || !r.result.completed) continue;
    if (isImplausibleRun(r.result.avgSpeedKmh, r.result.maxSpeedKmh)) continue;
    if (!best || r.result.durationMs < best.durationMs) best = r.result;
  }
  return best;
}

route("POST", "/api/solo", async ({ res, body }) => {
  const deviceId = (body.deviceId || "").trim();
  const distanceKey = body.distanceKey;
  if (!RACE_DISTANCES[distanceKey]) {
    return sendJson(res, 400, { error: `A valid distanceKey (${Object.keys(RACE_DISTANCES).join(", ")}) is required` });
  }
  const directionKey = RACE_DIRECTIONS[body.directionKey] ? body.directionKey : DEFAULT_RACE_DIRECTION;
  const lat = Number(body.lat);
  const lng = Number(body.lng);

  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  if (!me) return sendJson(res, 400, { error: "Unknown deviceId." });

  let course = null;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    try {
      course = await buildRaceCourse(
        { lat, lng },
        RACE_DIRECTIONS[directionKey].bearing,
        RACE_DISTANCES[distanceKey].meters
      );
    } catch (e) {
      course = null;
    }
  }

  // One run at a time: any earlier run of yours that never finished (you
  // backed out, or the app closed) is dropped rather than left to pile up.
  state.soloRuns = (state.soloRuns || []).filter((r) => !(r.userId === me.id && r.status === "ready"));
  const run = {
    id: db.id("solo"),
    userId: me.id,
    distanceKey,
    directionKey,
    course,
    status: "ready",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
  };
  state.soloRuns.push(run);
  await db.save(state);
  sendJson(res, 201, soloSummary(run, { includeCourse: true }));
});

// Your time, once you cross the line (or end the run by hand short of it --
// that still counts as driving for your stats, but not as a time).
route("POST", "/api/solo/:id/finish", async ({ res, params, body }) => {
  const deviceId = (body.deviceId || "").trim();
  const durationMs = Number(body.durationMs);
  const distanceM = Number(body.distanceM);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return sendJson(res, 400, { error: "A valid durationMs is required" });
  }
  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  if (!me) return sendJson(res, 400, { error: "Unknown deviceId." });
  const run = (state.soloRuns || []).find((r) => r.id === params.id);
  if (!run || run.userId !== me.id) return sendJson(res, 404, { error: "Run not found" });
  if (run.status !== "ready") return sendJson(res, 409, { error: "This run is already over." });

  const target = run.course ? run.course.distanceM : RACE_DISTANCES[run.distanceKey].meters;
  const completed = Number.isFinite(distanceM) ? distanceM >= target * 0.99 : false;
  const previousBest = bestSoloResult(state, me.id, run.distanceKey, run.id);

  run.result = buildRaceResult({
    durationMs,
    distanceM,
    avgSpeedKmh: Number(body.avgSpeedKmh),
    maxSpeedKmh: Number(body.maxSpeedKmh),
    completed,
    forfeited: false,
  });
  run.status = "finished";
  run.finishedAt = new Date().toISOString();
  await db.save(state);

  const counts = completed && !isImplausibleRun(run.result.avgSpeedKmh, run.result.maxSpeedKmh);
  const isPersonalBest = counts && (!previousBest || run.result.durationMs < previousBest.durationMs);

  // Where this time sits worldwide at this distance (everyone's best).
  let worldRank = null;
  if (counts) {
    const bests = new Map();
    for (const r of state.soloRuns) {
      if (r.distanceKey !== run.distanceKey || r.status !== "finished" || !r.result || !r.result.completed) continue;
      if (isImplausibleRun(r.result.avgSpeedKmh, r.result.maxSpeedKmh)) continue;
      const cur = bests.get(r.userId);
      if (cur == null || r.result.durationMs < cur) bests.set(r.userId, r.result.durationMs);
    }
    const mine = bests.get(me.id);
    worldRank = 1 + [...bests.values()].filter((t) => t < mine).length;
  }

  sendJson(res, 200, {
    ...soloSummary(run),
    counted: counts,
    isPersonalBest,
    previousBestMs: previousBest ? previousBest.durationMs : null,
    worldRank,
  });
});

// Backing out before you ever started: nothing to record.
route("POST", "/api/solo/:id/abandon", async ({ res, params, body }) => {
  const deviceId = (body.deviceId || "").trim();
  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  if (!me) return sendJson(res, 400, { error: "Unknown deviceId." });
  const before = (state.soloRuns || []).length;
  state.soloRuns = (state.soloRuns || []).filter(
    (r) => !(r.id === params.id && r.userId === me.id && r.status === "ready")
  );
  if (state.soloRuns.length !== before) await db.save(state);
  sendJson(res, 200, { abandoned: state.soloRuns.length !== before });
});

// Your personal bests per distance, plus recent finished runs.
route("GET", "/api/users/:deviceId/solo", async ({ res, params }) => {
  const state = await db.load();
  const user = findUserByDevice(state, params.deviceId);
  if (!user) return sendJson(res, 404, { error: "User not found" });
  const bests = {};
  for (const key of Object.keys(RACE_DISTANCES)) {
    const b = bestSoloResult(state, user.id, key);
    bests[key] = b
      ? { durationMs: b.durationMs, avgSpeedKmh: b.avgSpeedKmh, maxSpeedKmh: b.maxSpeedKmh, finishedAt: b.finishedAt }
      : null;
  }
  const runs = (state.soloRuns || [])
    .filter((r) => r.userId === user.id && r.status === "finished" && r.result)
    .sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt))
    .slice(0, 50)
    .map((r) => ({
      runId: r.id,
      distanceKey: r.distanceKey,
      distanceLabel: RACE_DISTANCES[r.distanceKey]?.label ?? "",
      durationMs: r.result.durationMs,
      distanceM: r.result.distanceM ?? 0,
      avgSpeedKmh: r.result.avgSpeedKmh,
      maxSpeedKmh: r.result.maxSpeedKmh,
      completed: r.result.completed,
      recordedAt: r.finishedAt,
    }));
  sendJson(res, 200, { bests, runs });
});

// "Clear whatever's open between us and let me challenge them again." The
// escape hatch for a race left open by a phone that closed mid-race: the
// challenge route refuses a second race with the same player, and before
// this there was no way to find that stale race's id from the app. Cancels
// (never finishes) every open race between the two, so nothing is recorded
// for either side.
route("POST", "/api/races/clear", async ({ res, body }) => {
  const deviceId = (body.deviceId || "").trim();
  const otherDeviceId = (body.otherDeviceId || "").trim();
  const state = await db.load();
  const me = findUserByDevice(state, deviceId);
  const them = findUserByDevice(state, otherDeviceId);
  if (!me) return sendJson(res, 400, { error: "Unknown deviceId." });
  if (!them) return sendJson(res, 404, { error: "That player isn't available right now." });

  let cleared = 0;
  for (const race of state.races) {
    normalizeRaceStatus(race);
    if (!["pending", "accepted"].includes(race.status)) continue;
    const pair =
      (race.fromUserId === me.id && race.toUserId === them.id) ||
      (race.fromUserId === them.id && race.toUserId === me.id);
    if (!pair) continue;
    race.status = "cancelled";
    race.finishedAt = new Date().toISOString();
    cleared += 1;
  }
  await db.save(state);
  sendJson(res, 200, { cleared });
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
