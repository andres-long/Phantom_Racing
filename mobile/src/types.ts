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

export type RaceProgress = { distanceM: number; elapsedMs: number; speedKmh: number; updatedAt: string };

export type RaceResult = {
  durationMs: number;
  distanceM: number | null;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  finishedAt: string;
};

export type RaceStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired" | "finished";

// Always from the current viewer's own side -- "my"/"opponent" rather than
// "from"/"to" -- see raceSummary() on the backend for why.
export type RaceChallenge = {
  id: string;
  distanceKey: RaceDistanceKey;
  distanceM: number;
  distanceLabel: string;
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

// ---- Worldwide stats leaderboard (Stats screen's WORLD tab) ------------

export type GlobalStatsMetric = "topSpeed" | "distance" | "avgSpeed";

export type GlobalStatsEntry = {
  rank: number;
  isMe: boolean;
  displayName: string;
  topSpeedKmh: number;
  distanceM: number;
  avgSpeedKmh: number;
  driveCount: number;
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

// Root navigator param list.
export type RootStackParamList = {
  Welcome: undefined;
  Disclaimer: undefined;
  Username: undefined;
  Home: undefined;
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
  RaceResult: { raceId: string };
};
