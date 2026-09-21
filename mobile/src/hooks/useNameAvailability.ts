import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";

export type NameStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available" }
  | { state: "unavailable"; reason: string };

// Checks, while you type, whether a racer name is free -- debounced so it
// only asks the server once you pause. The server re-checks on submit
// anyway (that's the real guarantee); this just tells you up front.
// `skip` turns it off (e.g. on the log-in form, or when the name is your
// current one).
export function useNameAvailability(name: string, opts: { skip?: boolean; deviceId?: string } = {}) {
  const [status, setStatus] = useState<NameStatus>({ state: "idle" });
  const tokenRef = useRef(0);

  useEffect(() => {
    const trimmed = name.trim();
    const token = ++tokenRef.current;
    if (opts.skip || !trimmed) {
      setStatus({ state: "idle" });
      return;
    }
    setStatus({ state: "checking" });
    const t = setTimeout(async () => {
      try {
        const res = await api.checkNameAvailable(trimmed, opts.deviceId);
        if (token !== tokenRef.current) return;
        setStatus(res.available ? { state: "available" } : { state: "unavailable", reason: res.reason || "Not available." });
      } catch {
        // Can't tell right now -- don't block; submit still checks.
        if (token === tokenRef.current) setStatus({ state: "idle" });
      }
    }, 450);
    return () => clearTimeout(t);
  }, [name, opts.skip, opts.deviceId]);

  return status;
}
