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
  rank: number;
  totalRuns: number;
  isNewRecord: boolean;
};

export type User = {
  id: string;
  deviceId: string;
  displayName: string;
  createdAt: string;
};

// Root navigator param list.
export type RootStackParamList = {
  Disclaimer: undefined;
  Home: undefined;
  CreateSegment: undefined;
  RecordRun: { segmentId: string };
  RunSummary: { result: SubmitRunResponse; segmentName: string; segmentId: string };
  Leaderboard: { segmentId: string; segmentName: string };
};
