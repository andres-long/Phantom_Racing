# Need for Speed: Streets (working title)

A real-life racing app: connect your phone, drive a stretch of road, and race against other people's recorded times on it — a "Strava segments, but it's a race" concept, built as a safety-conscious first cut of the original Need for Speed-in-real-life pitch.

## Why this version, not live head-to-head street racing

The original idea was live racing against real people on real highways/streets. That's genuinely dangerous and illegal in most places (street racing statutes, reckless driving, liability if someone crashes), so this MVP builds the fun part — real GPS, real roads, real competition — around **ghost/async racing** instead:

- You drive a road you already drive. The app times you.
- Your time gets ranked on a leaderboard for that "segment" (a defined stretch of road).
- Next time you drive it, you race live against the **ghost** of the current leader — a marker on your map showing where they were at each point in time, so you can see if you're ahead or behind, without ever sharing the road with them at the same moment.

Live head-to-head racing on closed courses/track days is a natural next iteration (see Roadmap below) — the architecture doesn't fight it, it's just not what's built yet.

**This is a prototype, not a polished product.** Treat it as a working skeleton to iterate on, not something to publish as-is.

## What's actually built

- **`server/`** — a small backend (Node.js, zero external dependencies) with the full API: register a user, create a segment from a GPS trace, submit a run, get a leaderboard, get a "ghost profile" for live racing. Has an automated end-to-end test (`npm test`) and it passes.
- **`mobile/`** — a React Native (Expo) app targeting **both Android and iOS from one codebase**: disclaimer/safety screen, segment list, record-a-new-segment flow, the live "race the ghost" screen (map + live ahead/behind timer), run summary, and leaderboard.
- The core, trickiest piece of the concept — projecting your live GPS position onto a road, and computing whether you're ahead or behind a recorded "ghost" run at that same point — is implemented and independently unit-tested on both the backend and the mobile app.

## Important limitation: this couldn't be run/installed in the sandbox that built it

The environment I built this in has no network access to the npm package registry (org policy), so I could not run `npm install`, could not launch Expo, and could not do a live end-to-end test of the mobile app. What I *could* do, and did:

- Wrote and ran an automated test suite against the real backend (`server/test/smoke-test.js`) — it starts the actual server and exercises the full flow (register → create segment → two runs → leaderboard ordering → ghost profile → rejecting an invalid run). All passing.
- Syntax-checked every mobile TypeScript file with the TypeScript compiler.
- Extracted the ghost-racing math (GPS-to-road projection, ghost interpolation) into standalone functions and unit-tested them directly (not just via the UI) — also passing.

What I could **not** verify: that the Expo app actually builds and runs, that `react-native-maps` behaves as expected on a real device, or anything about real-world GPS behavior (accuracy, drift, tunnels/urban canyons). You'll find out real fast once you run it on your phone — expect to spend real iteration time here, this is the part that can't be fully de-risked without a real device outdoors.

## Running it yourself

### Backend

```bash
cd server
npm start        # http://localhost:4000
npm test         # runs the automated smoke test
```

No `npm install` needed — it's dependency-free on purpose.

### Mobile app

This project's `mobile/` folder has hand-written source files but wasn't scaffolded by `create-expo-app` (couldn't reach npm from the build sandbox). Two ways to get it running:

**Option A — fastest path to something that runs:**
1. On a machine with normal internet access: `npx create-expo-app@latest mobile-fresh --template blank-typescript`
2. Copy this project's `mobile/App.tsx` and `mobile/src/` into that fresh project (overwrite `App.tsx`).
3. `cd mobile-fresh && npx expo install expo-location react-native-maps @react-navigation/native @react-navigation/native-stack react-native-screens react-native-safe-area-context @react-native-async-storage/async-storage` (`expo install` picks versions matched to your Expo SDK, safer than trusting the versions I guessed in `mobile/package.json`).
4. `npx expo start` → scan the QR code with **Expo Go** on your phone (Android or iOS, no app store publishing or Xcode needed for this).

**Option B — try installing directly in this `mobile/` folder** (works if *you* have npm registry access, even though I didn't): `cd mobile && npm install && npx expo start`.

### Connecting the app to the backend

Edit `mobile/src/api/client.ts` — `API_BASE_URL` is set to `http://localhost:4000`, which only works in a simulator. On a physical phone (the normal way to test GPS features), change it to your computer's LAN IP, e.g. `http://192.168.1.23:4000`, with your phone on the same Wi-Fi. Expo prints your LAN IP when you run `expo start`.

### Trying it for real

Once running: accept the disclaimer, tap "+ New segment", drive (safely, as a passenger or parked-then-driving-slowly for a first test) a short stretch of real road while recording, name it, then tap "Race it" to time a run against it. A second run — by you or someone else with the app pointed at the same backend — will show up as a ghost to race.

## Roadmap ideas (this concept has a lot of room)

- **Live racing on closed courses**: geofence "live mode" to autocross/track-day venues only, with real-time position sharing (WebSockets) between racers physically present.
- **Car/garage system**: cosmetic or stat-tracking "cars" tied to your phone/vehicle, lap-time personal bests per car.
- **Cop/pursuit mode**: one player is "police," others try to reach a destination without being "caught" (proximity-based, no speed incentive).
- **Social**: crews/teams, segment-of-the-week challenges, photo/video capture at the finish line.
- **Safety features**: automatic speed-limit awareness (via map data) that flags — not rewards — risky driving; a "clean drive" score alongside the raw time.
- **Real anti-cheat**: GPS spoofing detection, phone motion-sensor cross-checks, minimum realistic speed/acceleration bounds.
- **Monetization**: premium segments/cosmetics, sponsored real-world time trials (legal venues), leaderboards by city.
