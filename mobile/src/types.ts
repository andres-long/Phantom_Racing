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
};
