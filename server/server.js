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
const { URL } = require("url");
const db = require("./db");
const geo = require("./geo");

const PORT = process.env.PORT || 4000;

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
  };
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

// Create or fetch a user by device id. No real auth in the MVP -- a phone's
// generated device id is the identity.
route("POST", "/api/users", async ({ res, body }) => {
  const { deviceId, displayName } = body;
  if (!deviceId) return sendJson(res, 400, { error: "deviceId is required" });

  const state = await db.load();
  let user = findUserByDevice(state, deviceId);
  if (!user) {
    user = {
      id: db.id("user"),
      deviceId,
      displayName: displayName || "Racer",
      createdAt: new Date().toISOString(),
    };
    state.users.push(user);
    await db.save(state);
  } else if (displayName && displayName !== user.displayName) {
    user.displayName = displayName;
    await db.save(state);
  }
  sendJson(res, 200, user);
});

// List all segments with a leaderboard summary.
route("GET", "/api/segments", async ({ res }) => {
  const state = await db.load();
  sendJson(
    res,
    200,
    state.segments.map((s) => segmentSummary(state, s))
  );
});

// Create a new segment from a recorded polyline. The trace that defines the
// segment is a full lap of it, so it's auto-submitted as that segment's
// first timed run (see tryCreateRun) -- the response carries both the
// segment and (if the trace was a valid, plausible run) that first run.
route("POST", "/api/segments", async ({ res, body }) => {
  const { name, trace, deviceId, maxSpeedKmh } = body;
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
    createdAt: new Date().toISOString(),
  };
  state.segments.push(segment);

  const { run, error: runError } = tryCreateRun(state, segment, creator, cleanTrace, maxSpeedKmh);

  await db.save(state);
  sendJson(res, 201, { ...segmentSummary(state, segment), run, runError: run ? null : runError });
});

route("GET", "/api/segments/:id", async ({ res, params }) => {
  const state = await db.load();
  const segment = state.segments.find((s) => s.id === params.id);
  if (!segment) return sendJson(res, 404, { error: "Segment not found" });
  sendJson(res, 200, segmentSummary(state, segment));
});

route("GET", "/api/segments/:id/leaderboard", async ({ res, params }) => {
  const state = await db.load();
  const segment = state.segments.find((s) => s.id === params.id);
  if (!segment) return sendJson(res, 404, { error: "Segment not found" });

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
  if (!segment) return sendJson(res, 404, { error: "Segment not found" });

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
  if (!segment) return sendJson(res, 404, { error: "Segment not found" });

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
      recordedAt: r.recordedAt,
    }));
  sendJson(res, 200, runs);
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
