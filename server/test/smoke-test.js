// End-to-end smoke test for the backend. Pure Node (uses the global fetch
// available in Node 18+), no external test framework -- keeps `npm test`
// runnable with zero installs.
//
// Flow exercised: register two users -> create a segment -> both users
// submit a run along it -> leaderboard is ordered correctly -> ghost
// profile for the leader is retrievable -> a bogus/short run is rejected.

const path = require("path");
const fs = require("fs");
const assert = require("assert");

const DB_PATH = path.join(__dirname, "..", "data", "db.json");
// Start from a clean slate so repeated runs are deterministic.
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const server = require("../server");

const PORT = 4123;
const BASE = `http://localhost:${PORT}`;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// A straight "street": ~555m running north, as a stand-in for a real road.
const SEGMENT_START = { lat: 14.6300, lng: -90.5100 };
const SEGMENT_END = { lat: 14.6350, lng: -90.5100 };
const SEGMENT_POINTS = [SEGMENT_START, SEGMENT_END];

function buildTrace(startTimeMs, durationMs, sampleCount, jitter = 0) {
  const trace = [];
  for (let i = 0; i < sampleCount; i++) {
    const t = i / (sampleCount - 1);
    trace.push({
      lat: lerp(SEGMENT_START.lat, SEGMENT_END.lat, t) + (Math.random() - 0.5) * jitter,
      lng: lerp(SEGMENT_START.lng, SEGMENT_END.lng, t),
      t: startTimeMs + t * durationMs,
    });
  }
  return trace;
}

async function json(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function main() {
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Test server up on ${BASE}`);

  try {
    // Health check
    {
      const { status, data } = await json("GET", "/api/health");
      assert.strictEqual(status, 200);
      assert.strictEqual(data.ok, true);
      console.log("PASS health check");
    }

    // Register two users
    const alice = await json("POST", "/api/users", { deviceId: "device-alice", displayName: "Alice" });
    const bob = await json("POST", "/api/users", { deviceId: "device-bob", displayName: "Bob" });
    assert.strictEqual(alice.status, 200);
    assert.strictEqual(bob.status, 200);
    console.log("PASS user registration");

    // Create segment
    const segRes = await json("POST", "/api/segments", {
      name: "Test Straight",
      deviceId: "device-alice",
      points: SEGMENT_POINTS,
    });
    assert.strictEqual(segRes.status, 201, JSON.stringify(segRes.data));
    const segmentId = segRes.data.id;
    assert.ok(segRes.data.lengthM > 500 && segRes.data.lengthM < 600, `unexpected length ${segRes.data.lengthM}`);
    console.log(`PASS segment created (${segRes.data.lengthM}m)`);

    // Alice runs it slower (60s), Bob runs it faster (40s)
    const t0 = Date.now();
    const aliceTrace = buildTrace(t0, 60_000, 30);
    const bobTrace = buildTrace(t0 + 100_000, 40_000, 30);

    const aliceRun = await json("POST", `/api/segments/${segmentId}/runs`, {
      deviceId: "device-alice",
      trace: aliceTrace,
    });
    assert.strictEqual(aliceRun.status, 201, JSON.stringify(aliceRun.data));
    assert.strictEqual(aliceRun.data.rank, 1); // first run, so provisionally #1
    console.log(`PASS alice run recorded: ${aliceRun.data.durationMs}ms, rank ${aliceRun.data.rank}`);

    const bobRun = await json("POST", `/api/segments/${segmentId}/runs`, {
      deviceId: "device-bob",
      trace: bobTrace,
    });
    assert.strictEqual(bobRun.status, 201, JSON.stringify(bobRun.data));
    assert.strictEqual(bobRun.data.rank, 1); // bob is faster -> takes #1
    assert.strictEqual(bobRun.data.isNewRecord, true);
    console.log(`PASS bob run recorded: ${bobRun.data.durationMs}ms, rank ${bobRun.data.rank}`);

    // Leaderboard should have Bob first, Alice second
    const board = await json("GET", `/api/segments/${segmentId}/leaderboard`);
    assert.strictEqual(board.status, 200);
    assert.strictEqual(board.data.leaderboard.length, 2);
    assert.strictEqual(board.data.leaderboard[0].displayName, "Bob");
    assert.strictEqual(board.data.leaderboard[1].displayName, "Alice");
    console.log("PASS leaderboard ordering");

    // Ghost profile for the leader (Bob) should be retrievable and monotonic
    const ghost = await json("GET", `/api/segments/${segmentId}/ghost`);
    assert.strictEqual(ghost.status, 200);
    assert.strictEqual(ghost.data.displayName, "Bob");
    assert.ok(ghost.data.profile.length > 0);
    for (let i = 1; i < ghost.data.profile.length; i++) {
      assert.ok(ghost.data.profile[i].distanceAlongM >= ghost.data.profile[i - 1].distanceAlongM);
      assert.ok(ghost.data.profile[i].elapsedMs >= ghost.data.profile[i - 1].elapsedMs);
    }
    console.log("PASS ghost profile monotonic");

    // A trace that doesn't reach the end of the segment should be rejected
    const shortTrace = buildTrace(Date.now(), 20_000, 10).slice(0, 5); // never reaches the end
    const rejected = await json("POST", `/api/segments/${segmentId}/runs`, {
      deviceId: "device-alice",
      trace: shortTrace,
    });
    assert.strictEqual(rejected.status, 422);
    console.log(`PASS short/incomplete run rejected: "${rejected.data.error}"`);

    // Per-user run history
    const aliceRuns = await json("GET", "/api/users/device-alice/runs");
    assert.strictEqual(aliceRuns.status, 200);
    assert.strictEqual(aliceRuns.data.length, 1);
    console.log("PASS per-user run history");

    console.log("\nALL SMOKE TESTS PASSED");
    process.exitCode = 0;
  } catch (err) {
    console.error("\nSMOKE TEST FAILED:", err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
}

main();
