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
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "need_for_speed";
const STATE_DOC_ID = "state";

function emptyState() {
  return { users: [], segments: [], runs: [] };
}

// ---- JSON-file backend (local dev / no MONGODB_URI set) -------------------

function loadLocal() {
  if (!fs.existsSync(DB_PATH)) {
    saveLocal(emptyState());
  }
  const raw = fs.readFileSync(DB_PATH, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    return emptyState();
  }
}

function saveLocal(state) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2));
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
  return { users: doc.users || [], segments: doc.segments || [], runs: doc.runs || [] };
}

async function saveMongo(state) {
  const db = await getMongoDb();
  await db.collection("appState").updateOne(
    { _id: STATE_DOC_ID },
    { $set: { users: state.users, segments: state.segments, runs: state.runs } },
    { upsert: true }
  );
}

// ---- Public API -------------------------------------------------------

async function load() {
  return MONGODB_URI ? loadMongo() : loadLocal();
}

async function save(state) {
  return MONGODB_URI ? saveMongo(state) : saveLocal(state);
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

module.exports = { load, save, id, DB_PATH };
