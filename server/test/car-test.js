// Car / HP matching: saving your car, and it showing up on presence, races,
// the world stats board and track leaderboards. Run: node test/car-test.js
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const DATA = path.join(__dirname, "..", "data");
for (const f of ["db.json", "presence.json"]) if (fs.existsSync(path.join(DATA, f))) fs.unlinkSync(path.join(DATA, f));
const server = require("../server");
const PORT = 4124;
const BASE = `http://localhost:${PORT}`;
async function json(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
(async () => {
  await new Promise((r) => server.listen(PORT, r));
  try {
    const a = (await json("POST", "/api/auth/register", { displayName: "CarAlice", password: "pass1" })).data;
    const b = (await json("POST", "/api/auth/register", { displayName: "CarBob", password: "pass1" })).data;
    assert.equal(a.car, null);
    let r = await json("PUT", `/api/users/${a.deviceId}/car`, { car: { make: " Ford​ ", model: "Mustang   GT", hp: 450.4 } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.car, { make: "Ford", model: "Mustang GT", hp: 450 });
    console.log("PASS save car (cleaned)");
    for (const hp of [0, -5, 2001, "abc", null]) {
      r = await json("PUT", `/api/users/${a.deviceId}/car`, { car: { make: "X", model: "Y", hp } });
      assert.equal(r.status, 400, `hp ${hp}`);
    }
    console.log("PASS bad HP rejected");
    r = await json("PUT", `/api/users/nope/car`, { car: { make: "X", model: "Y", hp: 100 } });
    assert.equal(r.status, 404);
    r = await json("PUT", `/api/users/${b.deviceId}/car`, { car: { make: "Honda", model: "Civic", hp: 400 } });
    assert.equal(r.data.car.hp, 400);
    r = await json("PUT", `/api/users/${b.deviceId}/car`, { car: null });
    assert.equal(r.data.car, null);
    r = await json("PUT", `/api/users/${b.deviceId}/car`, { car: { make: "Honda", model: "Civic", hp: 400 } });
    console.log("PASS unknown user 404, clear car");
    // Presence
    await json("POST", "/api/presence", { deviceId: a.deviceId, lat: 14.63, lng: -90.51, heading: 0 });
    await json("POST", "/api/presence", { deviceId: b.deviceId, lat: 14.631, lng: -90.511, heading: 0 });
    r = await json("GET", `/api/presence?deviceId=${b.deviceId}&north=15&south=14&east=-90&west=-91`);
    const list = r.data.users || r.data;
    const alice = list.find((u) => u.displayName === "CarAlice");
    assert(alice, JSON.stringify(r.data).slice(0, 300));
    assert.equal(alice.car.hp, 450);
    console.log("PASS presence carries car");
    // Race summary carries opponent car
    r = await json("POST", "/api/races", { fromDeviceId: b.deviceId, toDeviceId: a.deviceId, distanceKey: "quarter" });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.opponentCar.hp, 450);
    console.log("PASS race opponentCar");
    // Segment + run -> leaderboard + world stats
    const trace = Array.from({ length: 30 }, (_, i) => ({ lat: 14.63 + (0.005 * i) / 29, lng: -90.51, t: 1e12 + i * 2000 }));
    r = await json("POST", "/api/segments", { name: "Car test", trace, deviceId: a.deviceId, maxSpeedKmh: 40, isPrivate: false });
    assert.equal(r.status, 201);
    const lb = await json("GET", `/api/segments/${r.data.id}/leaderboard`);
    const entries = lb.data.entries || lb.data.leaderboard || lb.data;
    assert.equal(entries[0].car.hp, 450, JSON.stringify(lb.data).slice(0, 300));
    console.log("PASS leaderboard car");
    const g = await json("GET", `/api/stats/global?metric=distance&deviceId=${b.deviceId}`);
    assert.equal(g.data.leaderboard.find((e) => e.displayName === "CarAlice").car.hp, 450);
    console.log("PASS world stats car");
    console.log("ALL CAR TESTS PASSED");
  } catch (e) {
    console.error("FAILED:", e);
    process.exitCode = 1;
  } finally {
    server.close();
    process.exit();
  }
})();
