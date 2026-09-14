import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, TextInput, Alert } from "react-native";
import MapView, { Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, LatLng } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { polylineLength } from "../utils/geo";

type Props = NativeStackScreenProps<RootStackParamList, "CreateSegment">;

// Drive (or walk) the stretch of road you want as a new segment once while
// recording; stop, name it, and it's immediately raceable/leaderboard-able.
export default function CreateSegmentScreen({ navigation }: Props) {
  const { user } = useUser();
  const [recording, setRecording] = useState(false);
  const [points, setPoints] = useState<LatLng[]>([]);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);

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
    setPoints([]);
    setSpeedKmh(0);
    setRecording(true);
    subscriptionRef.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 5 },
      (loc) => {
        setPoints((prev) => [...prev, { lat: loc.coords.latitude, lng: loc.coords.longitude }]);
        setSpeedKmh(Math.max(0, (loc.coords.speed ?? 0) * 3.6));
      }
    );
  };

  const stopRecording = () => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
    setRecording(false);
    if (points.length < 2) {
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
      await api.createSegment(name.trim(), points, user.deviceId);
      navigation.goBack();
    } catch (e: any) {
      Alert.alert("Couldn't save segment", e.message || "Unknown error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <MapView
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        showsUserLocation
        initialRegion={{
          latitude: points[0]?.lat ?? 14.6349,
          longitude: points[0]?.lng ?? -90.5069,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
      >
        {points.length > 1 && (
          <Polyline
            coordinates={points.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
            strokeColor="#ff3b30"
            strokeWidth={5}
          />
        )}
      </MapView>

      <View style={styles.hud}>
        <Text style={styles.hudText}>
          {recording ? `Recording... ${Math.round(polylineLength(points))}m` : "Not recording"}
        </Text>
        {recording && <Text style={styles.speedText}>{Math.round(speedKmh)} km/h</Text>}
      </View>

      {!naming ? (
        <Pressable
          style={[styles.button, recording && styles.buttonStop]}
          onPress={recording ? stopRecording : startRecording}
        >
          <Text style={styles.buttonText}>{recording ? "Stop" : "Start recording this road"}</Text>
        </Pressable>
      ) : (
        <View style={styles.namingBox}>
          <TextInput
            style={styles.input}
            placeholder="Segment name"
            placeholderTextColor="#8e8e96"
            value={name}
            onChangeText={setName}
            autoFocus
          />
          <Pressable style={styles.buttonInline} onPress={submit} disabled={submitting}>
            <Text style={styles.buttonText}>{submitting ? "Saving..." : "Save segment"}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f" },
  hud: { position: "absolute", top: 60, left: 20, right: 20, backgroundColor: "#000000aa", padding: 12, borderRadius: 12 },
  hudText: { color: "#fff", fontWeight: "600", textAlign: "center" },
  speedText: { color: "#c7c7cf", fontSize: 13, textAlign: "center", marginTop: 4 },
  button: {
    position: "absolute",
    bottom: 30,
    left: 20,
    right: 20,
    backgroundColor: "#ff3b30",
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  buttonStop: { backgroundColor: "#444" },
  buttonInline: {
    backgroundColor: "#ff3b30",
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  namingBox: { position: "absolute", bottom: 30, left: 20, right: 20 },
  input: {
    backgroundColor: "#17171d",
    color: "#fff",
    padding: 14,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#33333d",
  },
});
