import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "../api/client";
import { User } from "../types";
import { VehicleStyle } from "../components/VehicleMarker";
import { Units } from "../utils/units";
import { setTopSpeedUser } from "../topSpeed";

type UserContextValue = {
  user: User | null;
  loading: boolean;
  welcomeSeen: boolean;
  disclaimerAccepted: boolean;
  vehicleStyle: VehicleStyle;
  incognito: boolean;
  voiceEnabled: boolean;
  units: Units;
  showTracks: boolean;
  completeWelcome: () => Promise<void>;
  acceptDisclaimer: () => Promise<void>;
  register: (name: string, password: string) => Promise<void>;
  login: (name: string, password: string) => Promise<void>;
  setDisplayName: (name: string) => Promise<void>;
  setVehicleStyle: (style: VehicleStyle) => Promise<void>;
  setIncognito: (value: boolean) => Promise<void>;
  setVoiceEnabled: (value: boolean) => Promise<void>;
  setUnits: (value: Units) => Promise<void>;
  setShowTracks: (value: boolean) => Promise<void>;
  logOut: () => Promise<void>;
};

const UserContext = createContext<UserContextValue | null>(null);

const ACCOUNT_KEY = "nfs.account";
const WELCOME_KEY = "nfs.welcomeSeen";
const DISCLAIMER_KEY = "nfs.disclaimerAccepted";
const VEHICLE_STYLE_KEY = "nfs.vehicleStyle";
// Whether your live location is hidden from other users on the map (see
// HomeScreen's presence heartbeat/query). Local per-device preference, same
// as vehicleStyle -- there's no server-side "account setting" for it, just
// an `incognito` flag sent along with every heartbeat, so toggling it takes
// effect on the very next heartbeat rather than needing a round trip.
const INCOGNITO_KEY = "nfs.incognito";
// Whether you're reachable for proximity voice -- a separate, more specific
// opt-out than incognito (you can still be seen on the map but not audible,
// or vice versa isn't possible since voice requires knowing your position
// anyway). Same local-preference pattern, sent with every heartbeat so the
// server can exclude you from everyone else's nearby-voice list the moment
// you turn it off.
const VOICE_ENABLED_KEY = "nfs.voiceEnabled";
// Whether speed/distance are shown in mph/miles or km/h/kilometers. Local
// per-device preference, same as vehicleStyle -- purely a display choice,
// nothing the backend needs to know about (it always stores/returns km/h
// and meters; every screen converts at render time via ../utils/units).
const UNITS_KEY = "nfs.units";
// Whether recorded tracks are drawn on Home's map. Purely visual, local
// per-device preference; hiding them doesn't affect anything else (auto-
// start racing near a start line still works).
const SHOW_TRACKS_KEY = "nfs.showTracks";

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [welcomeSeen, setWelcomeSeen] = useState(false);
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);
  // Which icon marks you on the map -- purely cosmetic, so it's a local
  // per-device preference (like welcomeSeen/disclaimerAccepted above), not
  // something synced to the account on the backend.
  const [vehicleStyle, setVehicleStyleState] = useState<VehicleStyle>("jet");
  const [incognito, setIncognitoState] = useState(false);
  // Default on -- proximity voice is an opt-out feature, matching how
  // presence visibility defaults to on (incognito defaults false).
  const [voiceEnabled, setVoiceEnabledState] = useState(true);
  const [units, setUnitsState] = useState<Units>("metric");
  const [showTracks, setShowTracksState] = useState(true);

  useEffect(() => {
    (async () => {
      const seenWelcome = (await AsyncStorage.getItem(WELCOME_KEY)) === "true";
      setWelcomeSeen(seenWelcome);
      const accepted = (await AsyncStorage.getItem(DISCLAIMER_KEY)) === "true";
      setDisclaimerAccepted(accepted);
      const savedVehicleStyle = await AsyncStorage.getItem(VEHICLE_STYLE_KEY);
      if (savedVehicleStyle === "jet" || savedVehicleStyle === "arrow" || savedVehicleStyle === "bike") {
        setVehicleStyleState(savedVehicleStyle);
      }
      const savedIncognito = (await AsyncStorage.getItem(INCOGNITO_KEY)) === "true";
      setIncognitoState(savedIncognito);
      const savedVoiceEnabled = await AsyncStorage.getItem(VOICE_ENABLED_KEY);
      if (savedVoiceEnabled !== null) {
        setVoiceEnabledState(savedVoiceEnabled === "true");
      }
      const savedUnits = await AsyncStorage.getItem(UNITS_KEY);
      if (savedUnits === "metric" || savedUnits === "imperial") {
        setUnitsState(savedUnits);
      }
      const savedShowTracks = await AsyncStorage.getItem(SHOW_TRACKS_KEY);
      if (savedShowTracks !== null) {
        setShowTracksState(savedShowTracks === "true");
      }

      // A signed-in account, saved locally after register/login, so the
      // app doesn't ask again on every launch -- only a fresh install (or
      // an explicit log out) does. This is what makes a name and its
      // leaderboard history survive a reinstall or a new phone: log back
      // in there with the same name + password and this same account
      // (and everything tied to it) loads right back up.
      const savedAccount = await AsyncStorage.getItem(ACCOUNT_KEY);
      if (savedAccount) {
        try {
          setUser(JSON.parse(savedAccount));
        } catch {
          await AsyncStorage.removeItem(ACCOUNT_KEY);
        }
      }
      setLoading(false);
    })();
  }, []);

  // The passive top-speed tracker (topSpeed.ts) is module-level, not a
  // hook, so it needs telling whose account to record against whenever that
  // changes -- on cold start once the saved account loads, after a
  // login/register, and on log out (null, which stops it recording).
  useEffect(() => {
    setTopSpeedUser(user?.deviceId ?? null);
  }, [user?.deviceId]);

  const persistUser = async (nextUser: User) => {
    await AsyncStorage.setItem(ACCOUNT_KEY, JSON.stringify(nextUser));
    setUser(nextUser);
  };

  const register = async (name: string, password: string) => {
    const account = await api.register(name, password);
    await persistUser(account);
  };

  const login = async (name: string, password: string) => {
    const account = await api.login(name, password);
    await persistUser(account);
  };

  const setDisplayName = async (name: string) => {
    if (!user) return;
    const updated = await api.updateDisplayName(user.deviceId, name);
    await persistUser(updated);
  };

  const logOut = async () => {
    await AsyncStorage.removeItem(ACCOUNT_KEY);
    setUser(null);
  };

  const completeWelcome = async () => {
    await AsyncStorage.setItem(WELCOME_KEY, "true");
    setWelcomeSeen(true);
  };

  const acceptDisclaimer = async () => {
    await AsyncStorage.setItem(DISCLAIMER_KEY, "true");
    setDisclaimerAccepted(true);
  };

  const setVehicleStyle = async (style: VehicleStyle) => {
    await AsyncStorage.setItem(VEHICLE_STYLE_KEY, style);
    setVehicleStyleState(style);
  };

  const setIncognito = async (value: boolean) => {
    await AsyncStorage.setItem(INCOGNITO_KEY, value ? "true" : "false");
    setIncognitoState(value);
  };

  const setVoiceEnabled = async (value: boolean) => {
    await AsyncStorage.setItem(VOICE_ENABLED_KEY, value ? "true" : "false");
    setVoiceEnabledState(value);
  };

  const setUnits = async (value: Units) => {
    await AsyncStorage.setItem(UNITS_KEY, value);
    setUnitsState(value);
  };

  const setShowTracks = async (value: boolean) => {
    setShowTracksState(value);
    await AsyncStorage.setItem(SHOW_TRACKS_KEY, value ? "true" : "false");
  };

  return (
    <UserContext.Provider
      value={{
        user,
        loading,
        welcomeSeen,
        disclaimerAccepted,
        vehicleStyle,
        incognito,
        voiceEnabled,
        units,
        showTracks,
        completeWelcome,
        acceptDisclaimer,
        register,
        login,
        setDisplayName,
        setVehicleStyle,
        setIncognito,
        setVoiceEnabled,
        setUnits,
        setShowTracks,
        logOut,
      }}
    >
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used within a UserProvider");
  return ctx;
}
