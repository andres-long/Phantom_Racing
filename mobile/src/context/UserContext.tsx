import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "../api/client";
import { User } from "../types";
import { VehicleStyle } from "../components/VehicleMarker";

type UserContextValue = {
  user: User | null;
  loading: boolean;
  welcomeSeen: boolean;
  disclaimerAccepted: boolean;
  vehicleStyle: VehicleStyle;
  completeWelcome: () => Promise<void>;
  acceptDisclaimer: () => Promise<void>;
  register: (name: string, password: string) => Promise<void>;
  login: (name: string, password: string) => Promise<void>;
  setDisplayName: (name: string) => Promise<void>;
  setVehicleStyle: (style: VehicleStyle) => Promise<void>;
  logOut: () => Promise<void>;
};

const UserContext = createContext<UserContextValue | null>(null);

const ACCOUNT_KEY = "nfs.account";
const WELCOME_KEY = "nfs.welcomeSeen";
const DISCLAIMER_KEY = "nfs.disclaimerAccepted";
const VEHICLE_STYLE_KEY = "nfs.vehicleStyle";

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [welcomeSeen, setWelcomeSeen] = useState(false);
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);
  // Which icon marks you on the map -- purely cosmetic, so it's a local
  // per-device preference (like welcomeSeen/disclaimerAccepted above), not
  // something synced to the account on the backend.
  const [vehicleStyle, setVehicleStyleState] = useState<VehicleStyle>("jet");

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

  return (
    <UserContext.Provider
      value={{
        user,
        loading,
        welcomeSeen,
        disclaimerAccepted,
        vehicleStyle,
        completeWelcome,
        acceptDisclaimer,
        register,
        login,
        setDisplayName,
        setVehicleStyle,
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
