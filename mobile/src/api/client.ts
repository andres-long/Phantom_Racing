import {
  SegmentSummary,
  CreateSegmentResponse,
  LeaderboardResponse,
  GhostProfileResponse,
  SubmitRunResponse,
  User,
} from "../types";

// Points at the deployed backend (Render), so the app works over any
// network -- Wi-Fi or cellular data -- not just your computer's LAN. The
// free Render tier spins the server down after 15 minutes idle, so the
// first request after a quiet period can take ~30-60s to wake it back up.
export const API_BASE_URL = "https://phantom-racing.onrender.com";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  registerUser: (deviceId: string, displayName: string) =>
    request<User>("/api/users", {
      method: "POST",
      body: JSON.stringify({ deviceId, displayName }),
    }),

  listSegments: () => request<SegmentSummary[]>("/api/segments"),

  getSegment: (segmentId: string) => request<SegmentSummary>(`/api/segments/${segmentId}`),

  // `trace` is the full recorded drive (with timestamps) that defines this
  // segment -- the backend auto-submits it as the segment's first run, so
  // the response includes that run alongside the segment (see
  // CreateSegmentResponse).
  createSegment: (
    name: string,
    trace: { lat: number; lng: number; t: number }[],
    deviceId: string,
    maxSpeedKmh: number
  ) =>
    request<CreateSegmentResponse>("/api/segments", {
      method: "POST",
      body: JSON.stringify({ name, trace, deviceId, maxSpeedKmh }),
    }),

  getLeaderboard: (segmentId: string) =>
    request<LeaderboardResponse>(`/api/segments/${segmentId}/leaderboard`),

  getGhost: (segmentId: string, runId?: string) =>
    request<GhostProfileResponse>(
      `/api/segments/${segmentId}/ghost${runId ? `?runId=${runId}` : ""}`
    ),

  submitRun: (
    segmentId: string,
    deviceId: string,
    trace: { lat: number; lng: number; t: number }[],
    maxSpeedKmh: number
  ) =>
    request<SubmitRunResponse>(`/api/segments/${segmentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ deviceId, trace, maxSpeedKmh }),
    }),

  getUserRuns: (deviceId: string) => request<any[]>(`/api/users/${deviceId}/runs`),
};
