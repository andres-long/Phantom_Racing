import { Alert } from "react-native";
import * as Location from "expo-location";
import { api } from "./api/client";
import { haversine } from "./utils/geo";
import { LatLng, RootStackParamList } from "./types";

// Already this close to a track's start: no need to be driven there.
const ALREADY_THERE_M = 60;

type Track = { id: string; name: string; points: LatLng[] };
// Any screen's navigation object will do.
type Nav = { navigate: (...args: any[]) => void };

// "Take me to this track": turn-by-turn directions (the Go To drive) from
// where you are to the track's start line. When you get there it drops you
// straight into racing it (see GoRaceScreen's `trackId`).
export async function goToTrackStart(
  navigation: Nav,
  track: Track
): Promise<void> {
  if (track.points.length < 2) return;
  const start = track.points[0];
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== "granted") {
      Alert.alert("Location permission needed", "Directions to the track need to know where you are.");
      return;
    }
    let loc = await Location.getLastKnownPositionAsync({});
    if (!loc || Date.now() - loc.timestamp > 60000) {
      loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    }
    const origin = { lat: loc.coords.latitude, lng: loc.coords.longitude };

    if (haversine(origin, start) <= ALREADY_THERE_M) {
      const params: RootStackParamList["RecordRun"] = { segmentId: track.id };
      navigation.navigate("RecordRun", params);
      return;
    }

    const dir = await api.getDirections(origin, start);
    if (dir.points.length < 2) throw new Error("No driving route to that track's start.");
    const params: RootStackParamList["GoRace"] = {
      destinationName: `${track.name} -- start line`,
      destination: start,
      route: dir.points,
      distanceM: dir.distanceM,
      durationS: dir.durationS,
      trackId: track.id,
      trackName: track.name,
    };
    navigation.navigate("GoRace", params);
  } catch (e: any) {
    Alert.alert("Couldn't get directions", e.message || "Try again in a moment.");
  }
}
