import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "../api/client";
import { User } from "../types";

type UserContextValue = {
  user: User | null;
  loading: boolean;
  welcomeSeen: boolean;
  disclaimerAccepted: boolean;
  completeWelcome: () => Promise<void>;
  acceptDisclaimer: () => Promise<void>;
  register: (name: string, password: string) => Promise<void>;
  login: (name: string, password: string) => Promise<void>;
  setDisplayName: (name: string) => Promise<void>;
  logOut: () => Promise<void>;
};

const UserContext = createContext<UserContextValue | null>(null);

const ACCOUNT_KEY = "nfs.account";
const WELCOME_KEY = "nfs.welcomeSeen";
const DISCLAIMER_KEY = "nfs.disclaimerAccepted";

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [welcomeSeen, setWelcomeSeen] = useState(false);
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);

  useEffect(() => {
    (async () => {
      const seenWelcome = (await AsyncStorage.getItem(WELCOME_KEY)) === "true";
      setWelcomeSeen(seenWelcome);
      const accepted = (await AsyncStorage.getItem(DISCLAIMER_KEY)) === "true";
      setDisclaimerAccepted(accepted);

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

  return (
    <UserContext.Provider
      value={{
        user,
        loading,
        welcomeSeen,
        disclaimerAccepted,
        completeWelcome,
        acceptDisclaimer,
        register,
        login,
        setDisplayName,
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
