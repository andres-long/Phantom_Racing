import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, PermissionsAndroid, Platform } from "react-native";
import {
  MediaStream,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  mediaDevices,
  registerGlobals,
} from "react-native-webrtc";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { VoicePeer, VoiceSignal } from "../types";
import { PresencePositionRef } from "./usePresenceHeartbeat";

// react-native-webrtc expects this called once, early, so its native types
// (RTCPeerConnection, MediaStream, ...) get patched onto the global scope
// the way they would in a browser -- some of its own internals assume
// that's already true. Module scope, not inside the hook, so it only ever
// runs once no matter how many times this module is imported.
registerGlobals();

// How often to re-check who's in range and open/close connections to match.
// Matches the presence heartbeat cadence -- there's no point checking more
// often than position itself updates.
const NEARBY_POLL_MS = 5000;

// How often to check the signaling mailbox. Faster than the nearby-peer
// poll: an active call exchanges several ICE candidates in its first couple
// of seconds, and every one sits in the mailbox until we ask for it.
const SIGNAL_POLL_MS = 1500;

// STUN only for this MVP -- enough to connect on plenty of home/office wifi
// and a fair amount of cellular NAT, but not guaranteed for every carrier.
// There's no TURN relay to fall back to yet, so some pairs of racers on some
// networks may simply fail to connect audio to each other. Worth revisiting
// if "can't hear anyone nearby" reports come in.
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

type PeerEntry = {
  pc: RTCPeerConnection;
  displayName: string;
  connected: boolean;
};

// Real-time voice with whoever's nearby, unblocked, and voice-enabled right
// now: a mesh of direct WebRTC connections, one per peer, with the backend
// only ever relaying opaque SDP/ICE blobs it never looks inside (see
// server/db.js's voice-signal mailbox and server.js's /api/voice/* routes).
//
// Mirrors usePresenceHeartbeat: takes a position ref rather than owning GPS
// itself, so whatever screen is currently tracking location (Home, a live
// race, ...) can just keep this fed rather than proximity voice needing its
// own location subscription.
//
// IMPORTANT: this owns a single microphone stream and destructively drains
// a per-device signaling mailbox (each poll deletes what it reads). Calling
// it more than once at a time for the same signed-in user would mean two
// mic streams and two pollers racing to steal each other's signals. Mount
// it exactly once app-wide (see ProximityVoiceContext, which every screen
// actually consumes) rather than calling this hook directly from a screen.
//
// `positionReady` gates the mic request: Android can only show one
// permission dialog at a time, and a second request made while the first is
// still open comes back silently denied. Home asks for location as soon as
// it opens, so asking for the mic at the same instant (app launch) meant one
// or both prompts got auto-denied -- no position on the map, "MIC
// UNAVAILABLE". Waiting for the first GPS fix means location permission has
// already been answered before we ever ask for the mic.
export function useProximityVoice(posRef: PresencePositionRef, positionReady: boolean) {
  const { user, voiceEnabled } = useUser();

  const [connectedPeers, setConnectedPeers] = useState<VoicePeer[]>([]);
  const [talking, setTalkingState] = useState(false);
  const [micReady, setMicReady] = useState(false);
  // "Don't ask again" was chosen -- only the system settings screen can
  // turn the mic back on, so the UI should send the user there instead of
  // re-prompting (Android wouldn't show a prompt anyway).
  const [micBlocked, setMicBlocked] = useState(false);
  // Bumped by retryMic() to re-run the mic effect below on demand (e.g. the
  // user tapped "enable mic" after denying it once).
  const [micAttempt, setMicAttempt] = useState(0);

  const userRef = useRef(user);
  const talkingRef = useRef(false);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, any[]>>(new Map());
  const nearbyInFlightRef = useRef(false);
  const signalsInFlightRef = useRef(false);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const refreshConnectedPeers = useCallback(() => {
    const list: VoicePeer[] = [];
    peersRef.current.forEach((entry, deviceId) => {
      if (entry.connected) list.push({ deviceId, displayName: entry.displayName });
    });
    setConnectedPeers(list);
  }, []);

  const teardownPeer = useCallback(
    (deviceId: string) => {
      const entry = peersRef.current.get(deviceId);
      if (!entry) return;
      try {
        entry.pc.close();
      } catch {
        // Already closed/broken -- nothing more to do.
      }
      peersRef.current.delete(deviceId);
      pendingCandidatesRef.current.delete(deviceId);
      refreshConnectedPeers();
    },
    [refreshConnectedPeers]
  );

  // Creates (or returns the existing) connection to one peer. `asOfferer`
  // only controls whether we immediately create+send an SDP offer -- pass
  // false when we're calling this because an offer from them just arrived
  // (we're clearly the answerer in that case, whatever the deterministic
  // pick below would otherwise say -- their offer is already in flight).
  const ensurePeer = useCallback(
    (deviceId: string, displayName: string, asOfferer: boolean) => {
      const existing = peersRef.current.get(deviceId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const entry: PeerEntry = { pc, displayName, connected: false };
      peersRef.current.set(deviceId, entry);

      const stream = localStreamRef.current;
      if (stream) {
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      }

      // @ts-ignore -- react-native-webrtc's typings lag its runtime API a
      // touch; these events all exist on the native RTCPeerConnection.
      pc.onicecandidate = (event: any) => {
        if (!event.candidate) return;
        const me = userRef.current;
        if (!me) return;
        api.sendVoiceSignal(me.deviceId, deviceId, "ice", event.candidate.toJSON()).catch(() => {});
      };

      // @ts-ignore
      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        const isConnected = state === "connected" || state === "completed";
        const current = peersRef.current.get(deviceId);
        if (!current) return;
        if (current.connected !== isConnected) {
          current.connected = isConnected;
          refreshConnectedPeers();
        }
        if (state === "failed" || state === "closed" || state === "disconnected") {
          // "disconnected" can be a brief blip on some platforms, but for a
          // proximity feature the fallback is simple either way: tear down
          // and let the next nearby-poll tick re-offer from scratch, rather
          // than trying to tell a real drop apart from a blip.
          teardownPeer(deviceId);
        }
      };

      if (asOfferer) {
        (async () => {
          try {
            const offer = await pc.createOffer({});
            await pc.setLocalDescription(offer);
            const me = userRef.current;
            if (!me) return;
            await api.sendVoiceSignal(me.deviceId, deviceId, "offer", offer);
          } catch {
            // Offer creation/send failed -- tear down so the next
            // nearby-poll tick gets a clean retry instead of a half-open pc.
            teardownPeer(deviceId);
          }
        })();
      }

      return entry;
    },
    [refreshConnectedPeers, teardownPeer]
  );

  const flushPendingCandidates = useCallback(async (deviceId: string, pc: RTCPeerConnection) => {
    const queued = pendingCandidatesRef.current.get(deviceId);
    if (!queued || queued.length === 0) return;
    pendingCandidatesRef.current.delete(deviceId);
    for (const c of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        // A stray/late candidate failing to add isn't fatal -- the
        // connection can still succeed on whichever candidates did land.
      }
    }
  }, []);

  const handleSignal = useCallback(
    async (signal: VoiceSignal) => {
      const me = userRef.current;
      if (!me) return;

      if (signal.kind === "offer") {
        const entry = ensurePeer(signal.fromDeviceId, signal.fromDisplayName, false);
        try {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(signal.data));
          await flushPendingCandidates(signal.fromDeviceId, entry.pc);
          const answer = await entry.pc.createAnswer();
          await entry.pc.setLocalDescription(answer);
          await api.sendVoiceSignal(me.deviceId, signal.fromDeviceId, "answer", answer);
        } catch {
          teardownPeer(signal.fromDeviceId);
        }
        return;
      }

      if (signal.kind === "answer") {
        const entry = peersRef.current.get(signal.fromDeviceId);
        if (!entry) return; // Not mid-offer with them (stale/duplicate) -- ignore.
        try {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(signal.data));
          await flushPendingCandidates(signal.fromDeviceId, entry.pc);
        } catch {
          teardownPeer(signal.fromDeviceId);
        }
        return;
      }

      // ICE candidate.
      const entry = peersRef.current.get(signal.fromDeviceId);
      if (entry && entry.pc.remoteDescription) {
        try {
          await entry.pc.addIceCandidate(new RTCIceCandidate(signal.data));
        } catch {
          // Ignore -- see flushPendingCandidates' comment above.
        }
      } else {
        // pc doesn't exist yet, or its remote description hasn't landed --
        // queue it, flushed once setRemoteDescription resolves above.
        const queue = pendingCandidatesRef.current.get(signal.fromDeviceId) || [];
        queue.push(signal.data);
        pendingCandidatesRef.current.set(signal.fromDeviceId, queue);
      }
    },
    [ensurePeer, flushPendingCandidates, teardownPeer]
  );

  // Local mic stream: acquired once voice is on and we know who we are,
  // released the moment either stops being true. Starts muted (no
  // push-to-talk button held yet) -- see setTalking.
  useEffect(() => {
    let cancelled = false;
    if (!voiceEnabled || !user) {
      const stream = localStreamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
        setMicReady(false);
      }
      return;
    }
    if (localStreamRef.current) return;
    // Wait for location to be sorted out first (see positionReady above),
    // unless the user explicitly asked for the mic via retryMic().
    if (!positionReady && micAttempt === 0) return;
    (async () => {
      try {
        if (Platform.OS === "android") {
          const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
          if (cancelled) return;
          if (result !== PermissionsAndroid.RESULTS.GRANTED) {
            setMicBlocked(result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
            setMicReady(false);
            return;
          }
          setMicBlocked(false);
        }
        const stream = (await mediaDevices.getUserMedia({ audio: true, video: false })) as unknown as MediaStream;
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.getAudioTracks().forEach((t) => {
          t.enabled = talkingRef.current;
        });
        localStreamRef.current = stream;
        setMicReady(true);
      } catch {
        // Mic permission denied, or no mic available -- proximity voice
        // just silently doesn't work for this device rather than blocking
        // anything else the app does.
        setMicReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [voiceEnabled, user, positionReady, micAttempt]);

  const retryMic = useCallback(() => {
    setMicAttempt((n) => n + 1);
  }, []);

  // Nearby-peer discovery: opens a connection to every newly-in-range
  // unblocked device, closes the ones that dropped out (out of range, went
  // incognito/voice-off/offline, or got blocked -- all of which just mean
  // this device stops appearing in the server's answer).
  useEffect(() => {
    if (!voiceEnabled || !user || !micReady) return;
    let cancelled = false;

    const tick = async () => {
      const me = userRef.current;
      const pos = posRef.current;
      if (!me || !pos || nearbyInFlightRef.current || AppState.currentState !== "active") return;
      nearbyInFlightRef.current = true;
      try {
        const { peers } = await api.nearbyVoicePeers(me.deviceId, pos.coords);
        if (cancelled) return;
        const nearbyIds = new Set(peers.map((p) => p.deviceId));

        peersRef.current.forEach((_entry, deviceId) => {
          if (!nearbyIds.has(deviceId)) teardownPeer(deviceId);
        });

        peers.forEach((peer) => {
          if (peersRef.current.has(peer.deviceId)) return;
          // Deterministic offerer pick so both sides don't offer at once --
          // whichever deviceId sorts first always initiates. Both devices
          // run the exact same comparison, so they always agree on which
          // one that is without any extra signaling round-trip.
          const asOfferer = me.deviceId < peer.deviceId;
          ensurePeer(peer.deviceId, peer.displayName, asOfferer);
        });
      } catch {
        // Best-effort, same as presence -- next tick retries.
      } finally {
        nearbyInFlightRef.current = false;
      }
    };

    tick();
    const timer = setInterval(tick, NEARBY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [voiceEnabled, user, micReady, posRef, ensurePeer, teardownPeer]);

  // Signaling mailbox poll -- drains whatever offers/answers/ICE candidates
  // are waiting for us and feeds them into the matching peer connection.
  useEffect(() => {
    if (!voiceEnabled || !user || !micReady) return;
    let cancelled = false;

    const tick = async () => {
      const me = userRef.current;
      if (!me || signalsInFlightRef.current || AppState.currentState !== "active") return;
      signalsInFlightRef.current = true;
      try {
        const { signals } = await api.pollVoiceSignals(me.deviceId);
        if (cancelled) return;
        for (const signal of signals) {
          await handleSignal(signal);
        }
      } catch {
        // Best-effort -- a missed poll just means those signals wait one
        // more tick in the server-side mailbox; nothing is lost.
      } finally {
        signalsInFlightRef.current = false;
      }
    };

    tick();
    const timer = setInterval(tick, SIGNAL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [voiceEnabled, user, micReady, handleSignal]);

  // Full teardown the moment voice turns off (or this device signs out) --
  // don't leave connections open to devices that can no longer hear us.
  useEffect(() => {
    if (voiceEnabled && user) return;
    peersRef.current.forEach((_entry, deviceId) => teardownPeer(deviceId));
  }, [voiceEnabled, user, teardownPeer]);

  // Unmount: always close everything, regardless of why.
  useEffect(() => {
    return () => {
      peersRef.current.forEach((entry) => {
        try {
          entry.pc.close();
        } catch {
          // Already gone -- fine.
        }
      });
      peersRef.current.clear();
      const stream = localStreamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
    };
  }, []);

  // Push-to-talk: flips the *same* local audio track's `enabled` flag
  // everywhere it's attached (every open peer connection shares the one
  // track object), rather than adding/removing tracks per connection --
  // no renegotiation needed, just an on/off switch on what's already wired
  // up.
  const setTalking = useCallback((value: boolean) => {
    talkingRef.current = value;
    setTalkingState(value);
    const stream = localStreamRef.current;
    if (stream) {
      stream.getAudioTracks().forEach((t) => {
        t.enabled = value;
      });
    }
  }, []);

  return { connectedPeers, talking, setTalking, micReady, micBlocked, retryMic };
}
