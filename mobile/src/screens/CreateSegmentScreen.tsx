import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, Alert } from "react-native";
import MapView, { Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, LatLng } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { polylineLength } from "../utils/geo";
import { colors, fonts, panelStyle } from "../theme";
import NeonButton from "../components/NeonButton";

type Props = NativeStackScreenProps<RootStackParamList, "CreateSegment">;
type TracePoint = LatLng & { t: number };

// Drive (or walk) the stretch of road you want as a new segment once while
// recording; stop, name it, and it's immediately raceable/leaderboard-able.
// The recording itself is a full timed lap of the segment, so the backend
// auto-submits it as that segment's first run -- you land straight on the
// leaderboard instead of having to drive the same road again.
export default function CreateSegmentScreen({ navigation }: Props) {
  const { user } = useUser();
  const [recording, setRecording] = useState(false);
  const [trace, setTrace] = useState<TracePoint[]>([]);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const maxSpeedRef = useRef(0);
  const mapRef = useRef<MapView | null>(null);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Location permission needed", "This app can't record a route without location access.");
      }
    })();
    return () => {
      subscriptionRef.current?.remove();
    };
  }, []);

  const startRecording = async () => {
    setTrace([]);
    setSpeedKmh(0);
    maxSpeedRef.current = 0;
    setRecording(true);
    subscriptionRef.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 5 },
      (loc) => {
        const point = { lat: loc.coords.latitude, lng: loc.coords.longitude, t: Date.now() };
        setTrace((prev) => [...prev, point]);
        const currentSpeedKmh = Math.max(0, (loc.coords.speed ?? 0) * 3.6);
        setSpeedKmh(currentSpeedKmh);
        if (currentSpeedKmh > maxSpeedRef.current) {
          maxSpeedRef.current = currentSpeedKmh;
        }
        // Keep the map following you the whole recording, same as an actual
        // race -- otherwise the view stays wherever it opened and the road
        // you're drawing quickly runs off screen.
        mapRef.current?.animateToRegion(
          { latitude: point.lat, longitude: point.lng, latitudeDelta: 0.015, longitudeDelta: 0.015 },
          500
        );
      }
    );
  };

  const stopRecording = () => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
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
      const segment = await api.createSegment(name.trim(), trace, user.deviceId, maxSpeedRef.current);
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

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        showsUserLocation
        initialRegion={{
          latitude: trace[0]?.lat ?? 14.6349,
          longitude: trace[0]?.lng ?? -90.5069,
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
      </MapView>

      <View style={styles.hud}>
        <Text style={styles.hudText}>
          {recording ? `RECORDING -- ${Math.round(polylineLength(trace))}m` : "NOT RECORDING"}
        </Text>
        {recording && (
          <>
            <Text style={styles.speedText}>{Math.round(speedKmh)} km/h</Text>
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
  hud: { position: "absolute", top: 60, left: 20, right: 20, ...panelStyle, padding: 14 },
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
});
