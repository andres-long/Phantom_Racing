// Datastore, dependency-free by default: when MONGODB_URI is set (e.g. on a
// deployed backend), this reads/writes a MongoDB Atlas database so data
// survives restarts. When it isn't set (local dev on your own PC), it falls
// back to the original JSON-file store -- so nothing about local testing
// changes and no extra `npm install` is needed there.
//
// The whole app state (users/segments/runs) is kept as one document,
// mirroring the JSON-file shape exactly -- this keeps server.js's route
// handlers almost unchanged (load the whole state, mutate arrays in memory,
// save it back). If this app ever gets real concurrent traffic, splitting
// into separate collections with targeted queries would be the next
// iteration; for an MVP's write volume this is a reasonable, low-risk
// trade-off.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = path.join(__dirname, "data", "db.json");
const PRESENCE_PATH = path.join(__dirname, "data", "presence.json");
const VOICE_SIGNALS_PATH = path.join(__dirname, "data", "voiceSignals.json");
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "need_for_speed";
const STATE_DOC_ID = "state";

function emptyState() {
  return { users: [], segments: [], runs: [], trips: [], races: [], blocks: [], soloRuns: [] };
}

// ---- JSON-file backend (local dev / no MONGODB_URI set) -------------------

function loadLocal() {
  if (!fs.existsSync(DB_PATH)) {
    saveLocal(emptyState());
  }
  const raw = fs.readFileSync(DB_PATH, "utf8");
  try {
    const parsed = JSON.parse(raw);
    // Older db.json files (written before trips existed) won't have the
    // field -- default it rather than letting every trips route crash on
    // an undefined array.
    return { ...emptyState(), ...parsed };
  } catch (e) {
    return emptyState();
  }
}

function saveLocal(state) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2));
}

// ---- Live presence (who's using the app right now, and where) -------------
//
// Kept deliberately separate from the users/segments/runs/trips "state"
// document above: heartbeats land every few seconds per active user, and
// folding that into the same read-whole-doc/mutate/save-whole-doc pattern
// as the rest of this file would mean every heartbeat reads and rewrites
// every segment/run/trip too -- wasteful, and a real risk of two concurrent
// writes (a heartbeat and, say, a run submission) racing and one clobbering
// the other's changes to unrelated data. Presence gets its own small store
// with a targeted per-device upsert instead.
//
// A presence record is considered current only for PRESENCE_MAX_AGE_MS after
// its `updatedAt` -- there's no explicit "I'm leaving" call; the mobile app
// just stops heartbeating (app backgrounded/closed) and the record goes
// stale on its own, so nothing needs cleaning up on disconnect.

function loadPresenceLocal() {
  if (!fs.existsSync(PRESENCE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(PRESENCE_PATH, "utf8"));
  } catch (e) {
    return {};
  }
}

function savePresenceLocal(map) {
  fs.mkdirSync(path.dirname(PRESENCE_PATH), { recursive: true });
  fs.writeFileSync(PRESENCE_PATH, JSON.stringify(map, null, 2));
}

function upsertPresenceLocal(record) {
  const map = loadPresenceLocal();
  map[record.deviceId] = record;
  savePresenceLocal(map);
}

function matchesBounds(record, bounds) {
  if (!bounds) return true;
  if (record.lat > bounds.north || record.lat < bounds.south) return false;
  // Normal (non-antimeridian-crossing) box: west < east.
  if (bounds.west <= bounds.east) {
    return record.lng >= bounds.west && record.lng <= bounds.east;
  }
  // The visible map region wraps around the +/-180 line (e.g. viewing the
  // Pacific) -- the "inside" longitudes are the two outer wedges, not the
  // middle, so the comparison flips.
  return record.lng >= bounds.west || record.lng <= bounds.east;
}

function queryPresenceLocal({ excludeDeviceId, bounds, maxAgeMs, requireVoiceEnabled }) {
  const map = loadPresenceLocal();
  const cutoff = Date.now() - maxAgeMs;
  return Object.values(map).filter((record) => {
    if (record.deviceId === excludeDeviceId) return false;
    if (record.incognito) return false;
    // Older presence records (written before proximity voice existed) have
    // no voiceEnabled field at all -- treat that as "on" (opt-out feature),
    // same default the client itself uses.
    if (requireVoiceEnabled && record.voiceEnabled === false) return false;
    if (new Date(record.updatedAt).getTime() < cutoff) return false;
    return matchesBounds(record, bounds);
  });
}

// ---- Proximity voice signaling (WebRTC offer/answer/ICE relay) ------------
//
// Same reasoning as presence's own separate store above, just more so: an
// active call setup can produce several signals per second (an ICE
// candidate each), and folding that into the read-whole/mutate/save-whole
// `state` document would mean rewriting every user/segment/run/race/block on
// every single ICE candidate. This is a pure mailbox -- push appends a
// signal for its recipient, drain returns and *deletes* everything currently
// waiting for one deviceId (a signal is meant to be read exactly once by
// whichever device it's addressed to, not accumulated like presence or
// races). No cross-device query, no "get everyone's", so no separate
// bounds/radius logic is needed here at all.

function loadVoiceSignalsLocal() {
  if (!fs.existsSync(VOICE_SIGNALS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(VOICE_SIGNALS_PATH, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveVoiceSignalsLocal(map) {
  fs.mkdirSync(path.dirname(VOICE_SIGNALS_PATH), { recursive: true });
  fs.writeFileSync(VOICE_SIGNALS_PATH, JSON.stringify(map, null, 2));
}

function pushVoiceSignalLocal(signal) {
  const map = loadVoiceSignalsLocal();
  const list = map[signal.toDeviceId] || (map[signal.toDeviceId] = []);
  list.push(signal);
  saveVoiceSignalsLocal(map);
}

function drainVoiceSignalsLocal(toDeviceId) {
  const map = loadVoiceSignalsLocal();
  const list = map[toDeviceId] || [];
  if (list.length > 0) {
    delete map[toDeviceId];
    saveVoiceSignalsLocal(map);
  }
  return list;
}

// ---- MongoDB backend (MONGODB_URI set, e.g. on a deployed host) -----------

let mongoDbPromise = null;

function getMongoDb() {
  if (!mongoDbPromise) {
    // Required lazily so a local run without MONGODB_URI never needs the
    // `mongodb` package installed.
    const { MongoClient } = require("mongodb");
    const client = new MongoClient(MONGODB_URI);
    mongoDbPromise = client.connect().then((c) => c.db(MONGODB_DB_NAME));
    // If the connection attempt fails (e.g. a transient network/TLS blip,
    // or Atlas's IP access list not being updated yet), clear the cache so
    // the *next* request gets a fresh connection attempt instead of the
    // same rejected promise forever. Without this, one bad first connection
    // would permanently wedge every request until the process restarts.
    mongoDbPromise.catch(() => {
      mongoDbPromise = null;
    });
  }
  return mongoDbPromise;
}

async function loadMongo() {
  const db = await getMongoDb();
  const doc = await db.collection("appState").findOne({ _id: STATE_DOC_ID });
  if (!doc) return emptyState();
  return {
    users: doc.users || [],
    segments: doc.segments || [],
    runs: doc.runs || [],
    trips: doc.trips || [],
    races: doc.races || [],
    blocks: doc.blocks || [],
    soloRuns: doc.soloRuns || [],
  };
}

async function saveMongo(state) {
  const db = await getMongoDb();
  await db.collection("appState").updateOne(
    { _id: STATE_DOC_ID },
    {
      $set: {
        users: state.users,
        segments: state.segments,
        runs: state.runs,
        trips: state.trips || [],
        races: state.races || [],
        blocks: state.blocks || [],
        soloRuns: state.soloRuns || [],
      },
    },
    { upsert: true }
  );
}

async function upsertPresenceMongo(record) {
  const db = await getMongoDb();
  // Own collection (not the appState doc), keyed by deviceId, so a
  // heartbeat is a single targeted upsert -- same reasoning as the local
  // JSON-file version above.
  await db
    .collection("presence")
    .updateOne({ _id: record.deviceId }, { $set: { ...record } }, { upsert: true });
}

async function queryPresenceMongo({ excludeDeviceId, bounds, maxAgeMs, requireVoiceEnabled }) {
  const db = await getMongoDb();
  const cutoffIso = new Date(Date.now() - maxAgeMs).toISOString();
  const filter = {
    _id: { $ne: excludeDeviceId },
    incognito: { $ne: true },
    updatedAt: { $gte: cutoffIso },
  };
  if (requireVoiceEnabled) {
    filter.voiceEnabled = { $ne: false };
  }
  if (bounds) {
    filter.lat = { $gte: bounds.south, $lte: bounds.north };
    if (bounds.west <= bounds.east) {
      filter.lng = { $gte: bounds.west, $lte: bounds.east };
    }
    // Antimeridian-wrapped viewports are rare enough (and low-stakes enough
    // -- worst case a few extra/missing markers near the date line) that
    // the Mongo path skips the wraparound handling the local-file path has;
    // not worth an $or query for this MVP.
  }
  const docs = await db.collection("presence").find(filter).limit(300).toArray();
  return docs.map((d) => ({
    deviceId: d._id,
    displayName: d.displayName,
    lat: d.lat,
    lng: d.lng,
    heading: d.heading,
    updatedAt: d.updatedAt,
  }));
}

async function pushVoiceSignalMongo(signal) {
  const db = await getMongoDb();
  await db.collection("voiceSignals").insertOne(signal);
}

async function drainVoiceSignalsMongo(toDeviceId) {
  const db = await getMongoDb();
  const docs = await db.collection("voiceSignals").find({ toDeviceId }).limit(200).toArray();
  if (docs.length > 0) {
    await db.collection("voiceSignals").deleteMany({ _id: { $in: docs.map((d) => d._id) } });
  }
  return docs;
}

// ---- Public API -------------------------------------------------------

async function load() {
  return MONGODB_URI ? loadMongo() : loadLocal();
}

async function save(state) {
  return MONGODB_URI ? saveMongo(state) : saveLocal(state);
}

async function upsertPresence(record) {
  return MONGODB_URI ? upsertPresenceMongo(record) : upsertPresenceLocal(record);
}

async function queryPresence(opts) {
  return MONGODB_URI ? queryPresenceMongo(opts) : queryPresenceLocal(opts);
}

async function pushVoiceSignal(signal) {
  return MONGODB_URI ? pushVoiceSignalMongo(signal) : pushVoiceSignalLocal(signal);
}

async function drainVoiceSignals(toDeviceId) {
  return MONGODB_URI ? drainVoiceSignalsMongo(toDeviceId) : drainVoiceSignalsLocal(toDeviceId);
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

module.exports = {
  load,
  save,
  id,
  DB_PATH,
  upsertPresence,
  queryPresence,
  pushVoiceSignal,
  drainVoiceSignals,
};
