import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, Alert, Switch, ActivityIndicator } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, LatLng } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { polylineLength } from "../utils/geo";
import { displaySpeedKmh, speedUnit } from "../utils/units";
import { colors, fonts, panelStyle } from "../theme";
import { tronMapStyle } from "../mapStyle";
import NeonButton from "../components/NeonButton";
import VehicleMarker from "../components/VehicleMarker";
import {
  BackgroundLocationPoint,
  requestBackgroundLocationPermission,
  setBackgroundLocationListener,
  startBackgroundTracking,
  stopBackgroundTracking,
} from "../backgroundLocation";
import { usePresenceHeartbeat, PresencePositionRef } from "../hooks/usePresenceHeartbeat";

type Props = NativeStackScreenProps<RootStackParamList, "CreateSegment">;
type TracePoint = LatLng & { t: number };

// Drive (or walk) the stretch of road you want as a new segment once while
// recording; stop, name it, and it's immediately raceable/leaderboard-able.
// The recording itself is a full timed lap of the segment, so the backend
// auto-submits it as that segment's first run -- you land straight on the
// leaderboard instead of having to drive the same road again.
export default function CreateSegmentScreen({ navigation }: Props) {
  const { user, vehicleStyle, units } = useUser();
  const insets = useSafeAreaInsets();
  const [recording, setRecording] = useState(false);
  const [trace, setTrace] = useState<TracePoint[]>([]);
  const [myPos, setMyPos] = useState<LatLng | null>(null);
  const [locationReady, setLocationReady] = useState(false);
  const [heading, setHeading] = useState(0);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const maxSpeedRef = useRef(0);
  const mapRef = useRef<MapView | null>(null);
  // Keeps this device visible on other users' maps while recording -- see
  // usePresenceHeartbeat.
  const presencePosRef: PresencePositionRef = useRef(null);
  usePresenceHeartbeat(presencePosRef);

  useEffect(() => {
    // Same fix as GoToScreen: initialRegion is only read once at mount, so
    // we hold the map off until we have a real fix -- a fast cached one via
    // getLastKnownPositionAsync first, refined right after by a fresh
    // getCurrentPositionAsync -- instead of ever mounting on the hardcoded
    // fallback.
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Location permission needed", "This app can't record a route without location access.");
        if (!cancelled) setLocationReady(true);
        return;
      }
      try {
        const last = await Location.getLastKnownPositionAsync({});
        if (last && !cancelled) {
          setMyPos({ lat: last.coords.latitude, lng: last.coords.longitude });
          setLocationReady(true);
        }
      } catch {}
      // A fresh fix so the vehicle marker has somewhere accurate to sit
      // before you start recording -- the live watcher only runs while
      // recording.
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!cancelled) {
          setMyPos({ lat: loc.coords.latitude, lng: loc.coords.longitude });
          if (loc.coords.heading != null && loc.coords.heading >= 0) {
            setHeading(loc.coords.heading);
          }
          setLocationReady(true);
        }
      } catch {
        // No initial fix -- the marker just won't show until recording starts.
        if (!cancelled) setLocationReady(true);
      }
    })();
    return () => {
      cancelled = true;
      stopBackgroundTracking();
    };
  }, []);

  // Fed by the background-capable location task (see ../backgroundLocation)
  // instead of a plain watchPositionAsync subscription, so recording keeps
  // going if you lock the phone or switch apps mid-recording -- previously
  // this stopped the instant the app left the foreground.
  const handleLocationPoints = (points: BackgroundLocationPoint[]) => {
    if (points.length === 0) return;
    const newPoints: TracePoint[] = points.map((p) => ({ lat: p.lat, lng: p.lng, t: p.t }));
    setTrace((prev) => [...prev, ...newPoints]);

    const last = points[points.length - 1];
    setMyPos({ lat: last.lat, lng: last.lng });
    if (last.heading != null) setHeading(last.heading);
    presencePosRef.current = { coords: { lat: last.lat, lng: last.lng }, heading: last.heading ?? null };
    setSpeedKmh(last.speedKmh);
    if (last.speedKmh > maxSpeedRef.current) {
      maxSpeedRef.current = last.speedKmh;
    }
    // Keep the map following you the whole recording, same as an actual
    // race -- otherwise the view stays wherever it opened and the road
    // you're drawing quickly runs off screen.
    mapRef.current?.animateToRegion(
      { latitude: last.lat, longitude: last.lng, latitudeDelta: 0.008, longitudeDelta: 0.008 },
      500
    );
  };

  const startRecording = async () => {
    const bgGranted = await requestBackgroundLocationPermission();
    if (!bgGranted) {
      Alert.alert(
        "Background location not granted",
        'Recording will pause if you lock your phone or leave the app mid-recording. For uninterrupted recording, allow location access "All the time" in Settings.'
      );
    }
    setTrace([]);
    setSpeedKmh(0);
    maxSpeedRef.current = 0;
    setRecording(true);
    setBackgroundLocationListener(handleLocationPoints);
    await startBackgroundTracking("Recording a new road segment. Tap to return to Phantom Racing.");
  };

  const stopRecording = () => {
    stopBackgroundTracking();
    setRecording(false);
    if (trace.length < 2) {
      Alert.alert("Too short", "Record a bit more road before stopping.");
      return;
    }
    setNaming(true);
  };

  const submit = async () => {
    if (!user) {
      Alert.alert("Not connected", "Still connecting to the server -- please wait a moment and try again.");
      return;
    }
    if (!name.trim()) {
      Alert.alert("Name it", "Give this segment a name (e.g. \"Ridge Road westbound\").");
      return;
    }
    setSubmitting(true);
    try {
      const segment = await api.createSegment(name.trim(), trace, user.deviceId, maxSpeedRef.current, isPrivate);
      if (segment.run) {
        navigation.replace("RunSummary", {
          result: segment.run,
          segmentName: segment.name,
          segmentId: segment.id,
        });
      } else {
        Alert.alert(
          "Segment saved",
          segment.runError
            ? `"${segment.name}" is on the map, but your drive couldn't be counted as a run (${segment.runError}). Race it from the segments list to set a time.`
            : `"${segment.name}" is on the map. Race it from the segments list to set a time.`
        );
        navigation.goBack();
      }
    } catch (e: any) {
      Alert.alert("Couldn't save segment", e.message || "Unknown error");
    } finally {
      setSubmitting(false);
    }
  };

  if (!locationReady) {
    return (
      <View style={[styles.container, styles.mapLoading]}>
        <ActivityIndicator color={colors.cyan} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        customMapStyle={tronMapStyle}
        initialRegion={{
          latitude: trace[0]?.lat ?? myPos?.lat ?? 14.6349,
          longitude: trace[0]?.lng ?? myPos?.lng ?? -90.5069,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
      >
        {trace.length > 1 && (
          <Polyline
            coordinates={trace.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
            strokeColor={colors.cyan}
            strokeWidth={5}
          />
        )}
        {myPos && (
          <Marker
            coordinate={{ latitude: myPos.lat, longitude: myPos.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            rotation={heading}
            flat
            tracksViewChanges={false}
          >
            <VehicleMarker vehicleStyle={vehicleStyle} />
          </Marker>
        )}
      </MapView>

      <View style={[styles.hud, { top: insets.top + 20 }]}>
        <Text style={styles.hudText}>
          {recording
            ? `RECORDING -- ${
                units === "imperial"
                  ? `${Math.round(polylineLength(trace) * 3.28084)}ft`
                  : `${Math.round(polylineLength(trace))}m`
              }`
            : "NOT RECORDING"}
        </Text>
        {recording && (
          <>
            <Text style={styles.speedText}>
              {displaySpeedKmh(speedKmh, units)} {speedUnit(units)}
            </Text>
            <Text style={styles.trackingHint}>This drive will count as your first run on the leaderboard</Text>
          </>
        )}
      </View>

      {!naming ? (
        <NeonButton
          label={recording ? "STOP" : "START RECORDING THIS ROAD"}
          onPress={recording ? stopRecording : startRecording}
          variant={recording ? "outline" : "primary"}
          style={styles.button}
        />
      ) : (
        <View style={styles.namingBox}>
          <TextInput
            style={styles.input}
            placeholder="Segment name"
            placeholderTextColor={colors.textMuted}
            value={name}
            onChangeText={setName}
            autoFocus
          />
          <View style={styles.privateRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.privateLabel}>Private track</Text>
              <Text style={styles.privateHint}>
                {isPrivate
                  ? "Only you can see or race this -- you can make it public later."
                  : "Anyone can see and race this track."}
              </Text>
            </View>
            <Switch
              value={isPrivate}
              onValueChange={setIsPrivate}
              trackColor={{ false: colors.panelBorder, true: colors.racePrimaryDim }}
              thumbColor={isPrivate ? colors.racePrimary : colors.textMuted}
              ios_backgroundColor={colors.panelBorder}
            />
          </View>
          <NeonButton
            label={submitting ? "SAVING..." : "SAVE SEGMENT"}
            onPress={submit}
            disabled={submitting}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  mapLoading: { alignItems: "center", justifyContent: "center" },
  hud: { position: "absolute", left: 20, right: 20, ...panelStyle, padding: 14 },
  hudText: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 13, textAlign: "center", letterSpacing: 1 },
  speedText: { color: colors.cyan, fontFamily: fonts.display, fontSize: 20, textAlign: "center", marginTop: 6 },
  trackingHint: { color: colors.textSecondary, fontSize: 11, textAlign: "center", marginTop: 6 },
  button: {
    position: "absolute",
    bottom: 30,
    left: 20,
    right: 20,
  },
  namingBox: { position: "absolute", bottom: 30, left: 20, right: 20 },
  input: {
    backgroundColor: colors.panel,
    color: colors.textPrimary,
    padding: 14,
    borderRadius: 4,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.panelBorder,
  },
  privateRow: {
    ...panelStyle,
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    marginBottom: 10,
  },
  privateLabel: { color: colors.textPrimary, fontSize: 14, fontWeight: "700" },
  privateHint: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
});
