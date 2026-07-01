# Surface and reduce dropped (unrendered) trips

## Motivation

After fanning in all 8 NYCT feeds, the worker returns ~438 live trips but only
~401 render — ~37 are silently dropped by the frontend because they can't be
placed on the baked geometry. Two known drop classes:

- **`noTrack`** — the trip's `routeId|direction` has no baked Track. The only
  confirmed case is the Rockaway Park shuttle: the realtime feed reports routeId
  `SS`, but the baked `track-index.json` carries that service as `H`. All `SS`
  trips (4 in the sample) drop. (The express diamonds `6X/7X/FX` are *kept* in
  `track-index.json` and resolve fine — see Notes — so `SS → H` is the only
  feed-vs-baked routeId mismatch.)
- **`noStop`** — the trip's `lastKnownStop.stopId` isn't among its Track's
  `stops` (terminals / trains past the baked polyline). ~33 trips, expected for
  v0. NOT fixed here; the panel just makes them visible.

The fix: alias `SS → H` so the shuttle resolves, and replace the throwaway node
diff script with an always-available in-app **Advanced Stats** panel that tallies
drops each poll.

## Do NOT

- Do NOT attempt to fix or reduce the `noStop` drops — they are expected v0
  behavior. Only surface their count in the panel.
- Do NOT add aliases beyond `SS → H`. The audit found no other feed-vs-baked
  mismatch; `6X/7X/FX` already resolve.
- Do NOT re-implement the routeId/stop join in the panel. Classify each trip once
  via the new `resolveTrip` (below) and tally its result.
- Do NOT make the panel a keyboard-toggled "debug" overlay. It is a **UI control**
  ("Advanced Stats"), toggled by an on-screen button, off by default.
- Do NOT specify *what* diagnostic information the panel shows inside the behaviors
  doc — the doc states only that an Advanced Stats panel exists (see step 4).
- Do NOT touch the worker (`packages/worker`). The alias belongs on the web side
  where the Track is looked up, keeping the render contract unchanged.
- Do NOT change `TrainPose`'s shape or the interpolation math.

## Plan

### 1. Refactor drop classification into `resolveTrip` (`packages/web/src/trains.ts`)

Introduce a discriminated union and a `resolveTrip` that does the join exactly
once, so both rendering and the panel read from the same classification.

- Add exported types:
  ```ts
  export type DropCause = "noTrack" | "noStop";
  export type TripResolution =
    | { ok: true; pose: TrainPose }
    | { ok: false; cause: DropCause; routeId: string };
  ```
- Add `export function resolveTrip(trip, tracks, nowMs): TripResolution`. Move the
  current `poseForTrip` body into it:
  - `!track` → `{ ok: false, cause: "noTrack", routeId: <aliased routeId> }`
  - `d0 == null` (lastKnownStop not on track) → `{ ok: false, cause: "noStop", routeId: trip.routeId }`
  - otherwise → `{ ok: true, pose }`.
- Keep `poseForTrip` as a thin wrapper for any existing callers:
  `const r = resolveTrip(...); return r.ok ? r.pose : null;` (or delete it if
  `main.ts` is the only caller after step 2 — grep first; it currently is).

### 2. Alias `SS → H` in the Track lookup (`packages/web/src/trains.ts`)

- Add a small alias map next to `ROUTE_COLOR`:
  ```ts
  // Feed routeId -> baked track-index routeId. The Rockaway Park shuttle reports
  // "SS" in realtime but is baked as "H".
  const ROUTE_ALIAS: Record<string, string> = { SS: "H" };
  const bakedRouteId = (routeId: string) => ROUTE_ALIAS[routeId] ?? routeId;
  ```
- In `resolveTrip`, look up the Track with `bakedRouteId(trip.routeId)`:
  `tracks.get(trackKey(bakedRouteId(trip.routeId), trip.direction))`.
- Report the drop's `routeId` as the trip's original feed `routeId` (so the panel
  shows `noTrack SS`, matching operator expectations), not the aliased one.
- `colorFor` still keys on the original `trip.routeId`; leave it unchanged.

### 3. Advanced Stats panel (`packages/web/src/main.ts`, new `stats-panel.ts`, `style.css`)

Create `packages/web/src/stats-panel.ts` exporting a small class/factory that owns
its DOM and toggle. No framework — plain DOM, matching the vanilla style of the repo.

- `export interface DropTally { total: number; rendered: number; drops: Map<string, number>; }`
  where each `drops` key is `"<cause>:<routeId>"` (e.g. `"noStop:A"`, `"noTrack:SS"`).
- `StatsPanel`:
  - Builds a toggle **button** (label "Advanced Stats") and a collapsible content
    box, both appended to `document.body`. Panel content hidden by default; the
    button toggles it.
  - `update(tally: DropTally)` renders: `total`, `rendered`, `dropped`
    (= total − rendered), then one line per drop cause/route sorted for stable
    order, formatted like `noTrack SS: 4`, `noStop A: 3`. Only re-render the
    content when the panel is open (cheap-when-closed).
- Wire into `main.ts`:
  - Instantiate `StatsPanel` once after the map loads.
  - In `frame()`, replace the `.map(poseForTrip).filter(...)` block with a single
    pass over `snapshot.trips` calling `resolveTrip`: collect poses for
    `r.ok === true`, and increment a `drops` map keyed `${r.cause}:${r.routeId}`
    for `r.ok === false`. Call `networkLayer.setTrains(poses)` as before, then
    `statsPanel.update({ total, rendered: poses.length, drops })`.
  - `frame()` runs every rAF but the tally is trivial arithmetic; keep it inline
    (do not add throttling). The panel itself skips DOM work while closed.

### 4. Behavior note in the behaviors doc (`.rhidoc/01-product/03-behaviors.md`)

Add a new EARS section stating the app offers a toggleable Advanced Stats panel
surfacing diagnostic information about the current frame — **without** naming what
information it shows (per the workspace rule that docs hold decided intent, and per
the explicit instruction to leave the contents unspecified). Suggested placement:
after `## Interaction`. Suggested content:

```markdown
## Advanced Stats

An optional panel, off by default, that a rider can open to see diagnostic
information about the current frame beyond what the map itself shows.

- The Board shall offer a toggleable Advanced Stats panel, hidden by default,
  that a rider can open to inspect diagnostic information about the live frame.
```

Then run `rhidoc regenerate` (content edit inside an existing doc — do NOT create
or move docs). Do not edit the frontmatter `summary`/`tags` by hand unless
`regenerate` requires it; if regenerate reports the doc's summary is stale, extend
it minimally to mention the stats panel.

## Files to Modify

- `packages/web/src/trains.ts` — add `DropCause`/`TripResolution`, `resolveTrip`,
  `ROUTE_ALIAS`/`bakedRouteId`; keep/thin `poseForTrip`.
- `packages/web/src/stats-panel.ts` — NEW: `StatsPanel` + `DropTally`.
- `packages/web/src/main.ts` — instantiate panel; tally drops in `frame()` via
  `resolveTrip`; update panel each frame.
- `packages/web/src/style.css` — styles for the button + panel (fixed-position
  overlay, unobtrusive, readable on the black map).
- `.rhidoc/01-product/03-behaviors.md` — new Advanced Stats EARS section.

## Verification

```bash
just typecheck
just lint
just build
```

Then confirm the doc regenerated cleanly:

```bash
rhidoc regenerate
git -C . status --porcelain .rhidoc
```

Manual smoke (not gated, do if a dev server is convenient): `just dev-all`, open
the app, click **Advanced Stats** — it should show `total`/`rendered`/`dropped`
plus per-cause/route lines, and the `noTrack SS` line should be absent (shuttle
now resolves) while `noStop` lines remain.

## Out of Scope

- Reducing / fixing `noStop` drops.
- Off-route / reroute rendering and the uncertain-position blink (doc01.03).
- Baking a route→color asset (palette stays hardcoded in `trains.ts`).
- Any worker-side change.

## Notes

- Reference numbers came from diffing `curl localhost:8788/api/trips` against
  `track-index.json`. Sample drop tally:
  `{noStop:2:3, noStop:3:1, noStop:5:8, noStop:A:3, noStop:E:5, noStop:N:6,
  noStop:R:7, noTrack:SS:4}` — the panel should reproduce this shape live, minus
  `noTrack:SS` once the alias lands.
- Express diamonds `6X/7X/FX` are excluded from *display* geometry (commit
  `cdb06de`) but the motion index (`track-index.json`) still carries them, so
  express trips resolve — no alias needed.
- The web package has no test runner; verification is typecheck + lint + build.

## Surface after this phase

- `packages/web/src/trains.ts` exports `resolveTrip(trip, tracks, nowMs): TripResolution`,
  the `DropCause` and `TripResolution` types, and (still) `indexTracks`. `poseForTrip`
  either remains as a `null`-returning wrapper or is removed if unused.
- Feed routeId `SS` resolves to the baked `H` Track; drops are reported against the
  original feed `routeId`.
- `packages/web/src/stats-panel.ts` exports `StatsPanel` and `DropTally`.
- The app renders a UI-toggled, default-hidden Advanced Stats panel tallying
  total / rendered / dropped-by-cause each poll.
- `.rhidoc/01-product/03-behaviors.md` carries an `## Advanced Stats` behavior; the
  doc's contents deliberately do not specify what the panel displays.
- Unchanged: `TrainPose` shape, interpolation math (`distAt`/`pointAt`), the render
  contract (`@nyc-subwhere/contract`), and the worker.
