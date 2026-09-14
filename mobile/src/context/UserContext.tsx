import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "../api/client";
import { User } from "../types";

type UserContextValue = {
  user: User | null;
  loading: boolean;
  disclaimerAccepted: boolean;
  acceptDisclaimer: () => Promise<void>;
  setDisplayName: (name: string) => Promise<void>;
};

const UserContext = createContext<UserContextValue | null>(null);

const DEVICE_ID_KEY = "nfs.deviceId";
const DISCLAIMER_KEY = "nfs.disclaimerAccepted";

function randomId(): string {
  // Good enough uniqueness for an MVP device identifier; not a real UUID lib
  // to avoid another native dependency (expo-crypto) for something this
  // low-stakes.
  return "dev_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        let deviceId = await AsyncStorage.getItem(DEVICE_ID_KEY);
        if (!deviceId) {
          deviceId = randomId();
          await AsyncStorage.setItem(DEVICE_ID_KEY, deviceId);
        }
        const accepted = (await AsyncStorage.getItem(DISCLAIMER_KEY)) === "true";
        setDisclaimerAccepted(accepted);

        const registered = await api.registerUser(deviceId, "Racer");
        setUser(registered);
      } catch (e) {
        console.warn("Failed to initialize user / reach backend:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const acceptDisclaimer = async () => {
    await AsyncStorage.setItem(DISCLAIMER_KEY, "true");
    setDisclaimerAccepted(true);
  };

  const setDisplayName = async (name: string) => {
    if (!user) return;
    const updated = await api.registerUser(user.deviceId, name);
    setUser(updated);
  };

  return (
    <UserContext.Provider value={{ user, loading, disclaimerAccepted, acceptDisclaimer, setDisplayName }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used within a UserProvider");
  return ctx;
}
