export type LatLng = { lat: number; lng: number };

export type SegmentSummary = {
  id: string;
  name: string;
  lengthM: number;
  points: LatLng[];
  createdAt: string;
  runCount: number;
  bestTimeMs: number | null;
  bestTimeUser: string | null;
  creatorId: string;
  isPrivate: boolean;
};

export type LeaderboardEntry = {
  rank: number;
  runId: string;
  userId: string;
  displayName: string;
  durationMs: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  recordedAt: string;
};

export type LeaderboardResponse = {
  segmentId: string;
  segmentName: string;
  leaderboard: LeaderboardEntry[];
};

export type GhostProfileResponse = {
  runId: string;
  displayName: string;
  durationMs: number;
  profile: { distanceAlongM: number; elapsedMs: number }[];
};

export type SubmitRunResponse = {
  runId: string;
  durationMs: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  rank: number;
  totalRuns: number;
  isNewRecord: boolean;
};

// Response to creating a segment. The recording that defines a segment is
// itself a full lap of it, so the backend auto-submits it as that
// segment's first run -- `run` is that result, or null (with `runError`
// explaining why) if the trace couldn't be counted as a run. The segment
// itself is always saved either way.
export type CreateSegmentResponse = SegmentSummary & {
  run: SubmitRunResponse | null;
  runError: string | null;
};

export type User = {
  id: string;
  deviceId: string;
  displayName: string;
  createdAt: string;
};

// ---- "Go To a place" (destination search + turn-by-turn + tracked trip) --

export type PlacePrediction = { placeId: string; description: string };

export type PlaceDetails = {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
};

export type DirectionsResponse = {
  points: LatLng[];
  distanceM: number;
  durationS: number;
  durationInTrafficS: number | null;
  endAddress: string;
};

export type SubmitTripResponse = {
  tripId: string;
  destinationName: string;
  durationMs: number;
  distanceM: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  estimatedDurationMs: number | null;
  deltaMs: number | null;
};

// ---- Live presence (other users on the map) --------------------------

export type PresenceUser = {
  deviceId: string;
  displayName: string;
  lat: number;
  lng: number;
  heading: number | null;
  updatedAt: string;
};

export type MapBounds = { north: number; south: number; east: number; west: number };

// ---- Live race challenges (head-to-head against a nearby player) ------

export type RaceDistanceKey = "quarter" | "mile" | "five";

// Which way a race is run -- both racers agree up front, and only progress
// in that direction counts (see raceDirections.ts).
export type RaceDirectionKey = "north" | "east" | "south" | "west";

export type RaceProgress = { distanceM: number; elapsedMs: number; speedKmh: number; updatedAt: string };

export type RaceResult = {
  durationMs: number;
  distanceM: number | null;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  finishedAt: string;
  // Did they actually cover the target distance (rather than tapping FINISH
  // NOW part-way), and did they give up? Both matter for who won -- duration
  // alone can't decide it, since quitting early posts the shortest time.
  completed: boolean;
  forfeited: boolean;
};

export type RaceStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired" | "finished";

// Always from the current viewer's own side -- "my"/"opponent" rather than
// "from"/"to" -- see raceSummary() on the backend for why.
export type RaceChallenge = {
  id: string;
  distanceKey: RaceDistanceKey;
  distanceM: number;
  distanceLabel: string;
  directionKey: RaceDirectionKey;
  directionLabel: string;
  directionBearing: number;
  // The road course both racers drive: a real driving route from where the
  // race was accepted, the chosen way, cut to exactly the chosen distance.
  // `course` only comes back when loading the race (it's far too big to
  // re-send on every progress poll); `courseDistanceM` is null when routing
  // couldn't lay one out, in which case the race falls back to measuring
  // progress along the compass axis.
  courseDistanceM: number | null;
  course: LatLng[] | null;
  status: RaceStatus;
  createdAt: string;
  raceStartAt: string | null;
  isChallenger: boolean;
  fromDisplayName: string;
  toDisplayName: string;
  opponentDisplayName: string;
  myProgress: RaceProgress | null;
  opponentProgress: RaceProgress | null;
  myResult: RaceResult | null;
  opponentResult: RaceResult | null;
  // The server's clock when it answered (ms since epoch). The race screen
  // uses it to count down on server time rather than each phone's own
  // clock, which can be seconds apart.
  serverNow?: number;
};

// ---- Proximity voice (real-time audio with whoever's nearby) ----------

// A peer currently in voice range: close enough, voice-enabled, and not
// blocked either direction. Distinct from PresenceUser (map markers use a
// wider radius and include incognito/voice-off users too).
export type VoicePeer = {
  deviceId: string;
  displayName: string;
};

export type VoiceSignalKind = "offer" | "answer" | "ice";

// A relayed WebRTC signaling message -- the server is just a mailbox, it
// never looks at `data` (an SDP blob or ICE candidate, opaque to it).
export type VoiceSignal = {
  id: string;
  fromDeviceId: string;
  fromDisplayName: string;
  kind: VoiceSignalKind;
  data: any;
};

export type BlockedPlayer = { deviceId: string; displayName: string };

// ---- Personal drive history (feeds the Stats screen) ------------------

export type RunHistoryEntry = {
  runId: string;
  segmentId: string;
  segmentName: string;
  durationMs: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  distanceM: number;
  recordedAt: string;
};

export type TripHistoryEntry = {
  tripId: string;
  destinationName: string;
  durationMs: number;
  distanceM: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  estimatedDurationMs: number | null;
  recordedAt: string;
};

// A finished live race, from your own side of it -- the third source of
// drive stats alongside runs and trips.
export type RaceHistoryEntry = {
  raceId: string;
  opponentDisplayName: string;
  distanceLabel: string;
  directionLabel: string;
  durationMs: number;
  distanceM: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  forfeited: boolean;
  // true you won, false they did, null a dead heat or they never finished.
  won: boolean | null;
  recordedAt: string;
};

// Your fastest speed the app has ever seen, recorded even when you weren't
// racing or recording anything (see topSpeed.ts).
export type TopSpeedResponse = { topSpeedKmh: number; topSpeedAt: string | null };

// ---- Worldwide stats leaderboard (Stats screen's WORLD tab) ------------

export type GlobalStatsMetric =
  | "topSpeed"
  | "distance"
  | "avgSpeed"
  | "wins"
  // Fastest completed solo run at each distance (lower is better).
  | "soloQuarter"
  | "soloMile"
  | "soloFive";

export type GlobalStatsEntry = {
  rank: number;
  isMe: boolean;
  displayName: string;
  topSpeedKmh: number;
  distanceM: number;
  avgSpeedKmh: number;
  driveCount: number;
  // Head-to-head record: races finished, and how many of them they took.
  raceCount: number;
  raceWins: number;
  // Best completed solo time at each distance, ms -- null if none yet.
  soloQuarterMs: number | null;
  soloMileMs: number | null;
  soloFiveMs: number | null;
};

// ---- Solo timed runs ----------------------------------------------------

// A solo run against the clock on a real road course -- the same course a
// head-to-head race gets, just you. `course` comes back when the run is
// created; null if routing couldn't lay one out (then progress falls back to
// the compass axis, like a race without a course).
export type SoloRun = {
  id: string;
  distanceKey: RaceDistanceKey;
  distanceM: number;
  distanceLabel: string;
  directionKey: RaceDirectionKey;
  directionLabel: string;
  directionBearing: number;
  courseDistanceM: number | null;
  course: LatLng[] | null;
  status: "ready" | "finished";
  createdAt: string;
  result: RaceResult | null;
};

export type SoloFinishResponse = SoloRun & {
  // Did it go down as a time (covered the distance, plausible speeds)?
  counted: boolean;
  isPersonalBest: boolean;
  previousBestMs: number | null;
  // Where your best at this distance ranks worldwide; null if not counted.
  worldRank: number | null;
};

export type SoloBest = { durationMs: number; avgSpeedKmh: number; maxSpeedKmh: number; finishedAt: string };

export type SoloHistoryEntry = {
  runId: string;
  distanceKey: RaceDistanceKey;
  distanceLabel: string;
  durationMs: number;
  distanceM: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  completed: boolean;
  recordedAt: string;
};

export type SoloStatsResponse = {
  bests: Record<RaceDistanceKey, SoloBest | null>;
  runs: SoloHistoryEntry[];
};

export type GlobalStatsResponse = {
  metric: GlobalStatsMetric;
  totalRacers: number;
  // Average speed only ranks racers with at least this much driving.
  minDistanceM: number;
  leaderboard: GlobalStatsEntry[];
  // Your own row and rank, even if you're outside the top list; null if
  // you haven't recorded a qualifying drive yet.
  me: GlobalStatsEntry | null;
};

// What you're in the middle of while taking a look at the map/menu. The
// drive or race itself stays on the screen underneath (it keeps recording,
// timing and reporting the whole time) -- Home is pushed on top of it, shows
// a banner saying so, and going back drops you straight back into it.
export type BusyDrive = {
  kind: "run" | "segment" | "trip" | "race" | "solo";
  label: string;
};

// Root navigator param list.
export type RootStackParamList = {
  Welcome: undefined;
  Disclaimer: undefined;
  Username: undefined;
  // `challenge`: a racer's deviceId to open straight into the race picker
  // for -- how you race someone you spotted while recording.
  Home: { busy?: BusyDrive; challenge?: string } | undefined;
  AllSegments: undefined;
  CreateSegment: undefined;
  RecordRun: { segmentId: string; autoStart?: boolean };
  RunSummary: { result: SubmitRunResponse; segmentName: string; segmentId: string };
  Leaderboard: { segmentId: string; segmentName: string };
  GoTo: undefined;
  GoRace: {
    destinationName: string;
    destination: LatLng;
    route: LatLng[];
    distanceM: number;
    durationS: number;
  };
  GoSummary: { result: SubmitTripResponse };
  Stats: undefined;
  RaceLive: { raceId: string };
  SoloRun: { distanceKey: RaceDistanceKey; directionKey: RaceDirectionKey };
  RaceResult: { raceId: string };
};
