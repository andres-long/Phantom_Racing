import {
  SegmentSummary,
  LeaderboardResponse,
  GhostProfileResponse,
  SubmitRunResponse,
  User,
  LatLng,
} from "../types";

// IMPORTANT: "localhost" from a physical phone means the phone itself, not
// your computer. When testing with Expo Go on a real device, set this to
// your computer's LAN IP (e.g. "http://192.168.1.23:4000") -- both devices
// need to be on the same Wi-Fi network. The Expo dev server prints your
// LAN IP on startup, which is usually the same address.
export const API_BASE_URL = "http://192.168.1.158:4000";

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

  createSegment: (name: string, points: LatLng[], deviceId: string) =>
    request<SegmentSummary>("/api/segments", {
      method: "POST",
      body: JSON.stringify({ name, points, deviceId }),
    }),

  getLeaderboard: (segmentId: string) =>
    request<LeaderboardResponse>(`/api/segments/${segmentId}/leaderboard`),

  getGhost: (segmentId: string, runId?: string) =>
    request<GhostProfileResponse>(
      `/api/segments/${segmentId}/ghost${runId ? `?runId=${runId}` : ""}`
    ),

  submitRun: (segmentId: string, deviceId: string, trace: { lat: number; lng: number; t: number }[]) =>
    request<SubmitRunResponse>(`/api/segments/${segmentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ deviceId, trace }),
    }),

  getUserRuns: (deviceId: string) => request<any[]>(`/api/users/${deviceId}/runs`),
};
