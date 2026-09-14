import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "../api/client";
import { User } from "../types";

type UserContextValue = {
  user: User | null;
  loading: boolean;
  error: string | null;
  disclaimerAccepted: boolean;
  acceptDisclaimer: () => Promise<void>;
  setDisplayName: (name: string) => Promise<void>;
  retry: () => Promise<void>;
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);

  // Registers this device with the backend. Returns true on success. Used
  // both on startup and from a manual "Retry" button.
  const register = async (): Promise<boolean> => {
    setError(null);
    try {
      let deviceId = await AsyncStorage.getItem(DEVICE_ID_KEY);
      if (!deviceId) {
        deviceId = randomId();
        await AsyncStorage.setItem(DEVICE_ID_KEY, deviceId);
      }
      const registered = await api.registerUser(deviceId, "Racer");
      setUser(registered);
      return true;
    } catch (e: any) {
      // The backend's free tier can take up to ~60s to wake up from idle,
      // or may be mid-deploy for a few seconds -- so a first failure here
      // doesn't necessarily mean anything is actually broken.
      console.warn("Failed to reach backend:", e);
      setError(e.message || "Couldn't reach the server.");
      return false;
    }
  };

  useEffect(() => {
    (async () => {
      const accepted = (await AsyncStorage.getItem(DISCLAIMER_KEY)) === "true";
      setDisclaimerAccepted(accepted);

      // Retry a handful of times with a short delay before giving up and
      // showing a manual retry screen -- covers the free-tier cold-start
      // case without making the person tap Retry themselves every time.
      for (let attempt = 0; attempt < 8; attempt++) {
        const ok = await register();
        if (ok) break;
        if (attempt < 7) await sleep(5000);
      }
      setLoading(false);
    })();
  }, []);

  const retry = async () => {
    setLoading(true);
    await register();
    setLoading(false);
  };

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
    <UserContext.Provider
      value={{ user, loading, error, disclaimerAccepted, acceptDisclaimer, setDisplayName, retry }}
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
