import {
  SegmentSummary,
  CreateSegmentResponse,
  LeaderboardResponse,
  GhostProfileResponse,
  SubmitRunResponse,
  User,
  LatLng,
  PlacePrediction,
  PlaceDetails,
  DirectionsResponse,
  SubmitTripResponse,
  PresenceUser,
  MapBounds,
  RunHistoryEntry,
  TripHistoryEntry,
  RaceChallenge,
  RaceDistanceKey,
  VoicePeer,
  VoiceSignal,
  VoiceSignalKind,
  BlockedPlayer,
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
  // Creates a real account (racer name + password) so it -- and everything
  // tied to it -- can be logged back into from any device.
  register: (displayName: string, password: string) =>
    request<User>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ displayName, password }),
    }),

  login: (displayName: string, password: string) =>
    request<User>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ displayName, password }),
    }),

  updateDisplayName: (deviceId: string, displayName: string) =>
    request<User>(`/api/users/${deviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    }),

  // `deviceId` is optional -- pass it so your own private tracks come back
  // alongside the public ones; omit it (or an anonymous caller) for the
  // public list only.
  listSegments: (deviceId?: string) =>
    request<SegmentSummary[]>(`/api/segments${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ""}`),

  getSegment: (segmentId: string, deviceId?: string) =>
    request<SegmentSummary>(
      `/api/segments/${segmentId}${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ""}`
    ),

  // `trace` is the full recorded drive (with timestamps) that defines this
  // segment -- the backend auto-submits it as the segment's first run, so
  // the response includes that run alongside the segment (see
  // CreateSegmentResponse). `isPrivate` starts the track hidden from
  // everyone but you -- toggle it later with setSegmentPrivacy.
  createSegment: (
    name: string,
    trace: { lat: number; lng: number; t: number }[],
    deviceId: string,
    maxSpeedKmh: number,
    isPrivate: boolean
  ) =>
    request<CreateSegmentResponse>("/api/segments", {
      method: "POST",
      body: JSON.stringify({ name, trace, deviceId, maxSpeedKmh, isPrivate }),
    }),

  // Flip a track you created between private and public.
  setSegmentPrivacy: (segmentId: string, deviceId: string, isPrivate: boolean) =>
    request<SegmentSummary>(`/api/segments/${segmentId}`, {
      method: "PATCH",
      body: JSON.stringify({ deviceId, isPrivate }),
    }),

  getLeaderboard: (segmentId: string, deviceId?: string) =>
    request<LeaderboardResponse>(
      `/api/segments/${segmentId}/leaderboard${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ""}`
    ),

  getGhost: (segmentId: string, runId?: string, deviceId?: string) => {
    const params = new URLSearchParams();
    if (runId) params.set("runId", runId);
    if (deviceId) params.set("deviceId", deviceId);
    const qs = params.toString();
    return request<GhostProfileResponse>(`/api/segments/${segmentId}/ghost${qs ? `?${qs}` : ""}`);
  },

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

  getUserRuns: (deviceId: string) => request<RunHistoryEntry[]>(`/api/users/${deviceId}/runs`),

  getUserTrips: (deviceId: string) => request<TripHistoryEntry[]>(`/api/users/${deviceId}/trips`),

  // "Go to a place" -- destination search (Places), routing (Directions),
  // and submitting the resulting drive as a tracked trip.
  placesAutocomplete: (query: string, near?: LatLng) =>
    request<{ predictions: PlacePrediction[] }>(
      `/api/places/autocomplete?query=${encodeURIComponent(query)}${
        near ? `&lat=${near.lat}&lng=${near.lng}` : ""
      }`
    ),

  placeDetails: (placeId: string) =>
    request<PlaceDetails>(`/api/places/details?placeId=${encodeURIComponent(placeId)}`),

  getDirections: (origin: LatLng, destination: LatLng) =>
    request<DirectionsResponse>(
      `/api/directions?originLat=${origin.lat}&originLng=${origin.lng}&destLat=${destination.lat}&destLng=${destination.lng}`
    ),

  submitTrip: (
    deviceId: string,
    destinationName: string,
    destination: LatLng,
    trace: { lat: number; lng: number; t: number }[],
    maxSpeedKmh: number,
    estimatedDurationS: number | null
  ) =>
    request<SubmitTripResponse>("/api/trips", {
      method: "POST",
      body: JSON.stringify({ deviceId, destinationName, destination, trace, maxSpeedKmh, estimatedDurationS }),
    }),

  // Live presence -- "who else is using the app right now, and where."
  // sendHeartbeat is fire-and-forget from the caller's point of view (Home
  // screen swallows failures so a dropped heartbeat never surfaces as an
  // error to the driver); queryPresence takes the current visible map
  // region so the same call naturally covers "who's near me" and "who's
  // over there" after panning.
  sendHeartbeat: (
    deviceId: string,
    position: LatLng,
    heading: number | null,
    incognito: boolean,
    voiceEnabled: boolean
  ) =>
    request<{ ok: true }>("/api/presence", {
      method: "POST",
      body: JSON.stringify({ deviceId, lat: position.lat, lng: position.lng, heading, incognito, voiceEnabled }),
    }),

  queryPresence: (deviceId: string, bounds: MapBounds) =>
    request<{ users: PresenceUser[] }>(
      `/api/presence?deviceId=${encodeURIComponent(deviceId)}&north=${bounds.north}&south=${bounds.south}&east=${bounds.east}&west=${bounds.west}`
    ),

  // Live race challenges -- head-to-head against a specific nearby player,
  // addressed by deviceId (the same id presence markers already carry, so a
  // tap on a marker needs no extra lookup).
  createRaceChallenge: (fromDeviceId: string, toDeviceId: string, distanceKey: RaceDistanceKey) =>
    request<RaceChallenge>("/api/races", {
      method: "POST",
      body: JSON.stringify({ fromDeviceId, toDeviceId, distanceKey }),
    }),

  getIncomingRaceChallenges: (deviceId: string) =>
    request<RaceChallenge[]>(`/api/races/incoming?deviceId=${encodeURIComponent(deviceId)}`),

  getRaceChallenge: (raceId: string, deviceId: string) =>
    request<RaceChallenge>(`/api/races/${raceId}?deviceId=${encodeURIComponent(deviceId)}`),

  respondToRaceChallenge: (raceId: string, deviceId: string, accept: boolean) =>
    request<RaceChallenge>(`/api/races/${raceId}/respond`, {
      method: "POST",
      body: JSON.stringify({ deviceId, accept }),
    }),

  postRaceProgress: (raceId: string, deviceId: string, distanceM: number, elapsedMs: number, speedKmh: number) =>
    request<RaceChallenge>(`/api/races/${raceId}/progress`, {
      method: "POST",
      body: JSON.stringify({ deviceId, distanceM, elapsedMs, speedKmh }),
    }),

  finishRace: (
    raceId: string,
    deviceId: string,
    durationMs: number,
    distanceM: number,
    avgSpeedKmh: number,
    maxSpeedKmh: number
  ) =>
    request<RaceChallenge>(`/api/races/${raceId}/finish`, {
      method: "POST",
      body: JSON.stringify({ deviceId, durationMs, distanceM, avgSpeedKmh, maxSpeedKmh }),
    }),

  cancelRace: (raceId: string, deviceId: string) =>
    request<RaceChallenge>(`/api/races/${raceId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ deviceId }),
    }),

  // Proximity voice -- real-time audio (WebRTC) with whoever's nearby right
  // now. The server never touches audio itself: `nearbyVoicePeers` says who
  // you should be connected to, and `sendVoiceSignal`/`pollVoiceSignals` are
  // just a mailbox for the SDP offers/answers/ICE candidates the two
  // devices negotiate directly with each other.
  nearbyVoicePeers: (deviceId: string, position: LatLng) =>
    request<{ peers: VoicePeer[] }>(
      `/api/voice/nearby?deviceId=${encodeURIComponent(deviceId)}&lat=${position.lat}&lng=${position.lng}`
    ),

  sendVoiceSignal: (fromDeviceId: string, toDeviceId: string, kind: VoiceSignalKind, data: any) =>
    request<{ ok: true }>("/api/voice/signal", {
      method: "POST",
      body: JSON.stringify({ fromDeviceId, toDeviceId, kind, data }),
    }),

  // Drains (not just reads) whatever signals have arrived since the last
  // poll -- see the backend route for why a mailbox model fits WebRTC
  // signaling better than the "always returns the full list" pattern used
  // elsewhere (races, presence).
  pollVoiceSignals: (deviceId: string) =>
    request<{ signals: VoiceSignal[] }>(`/api/voice/signal?deviceId=${encodeURIComponent(deviceId)}`),

  blockPlayer: (deviceId: string, blockedDeviceId: string) =>
    request<{ ok: true }>("/api/voice/block", {
      method: "POST",
      body: JSON.stringify({ deviceId, blockedDeviceId }),
    }),

  unblockPlayer: (deviceId: string, blockedDeviceId: string) =>
    request<{ ok: true }>("/api/voice/unblock", {
      method: "POST",
      body: JSON.stringify({ deviceId, blockedDeviceId }),
    }),

  getBlockedPlayers: (deviceId: string) =>
    request<{ blocked: BlockedPlayer[] }>(`/api/voice/blocked?deviceId=${encodeURIComponent(deviceId)}`),
};
