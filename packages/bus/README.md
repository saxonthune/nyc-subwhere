# Shared NYC bus service

Subwhere owns timetable lookup and Bus Time reconciliation. Running Late NYC supplies the curb and the earliest boarding instant after walking and applying its boarding margin. Its Worker can proxy these GET requests from the same origin as its app.

## Start here

The local verification used `http://127.0.0.1:8797` for live data and `http://127.0.0.1:8798` for the schedule-only KV archive. In Subwhere, open **Menu**, select **Show buses**, and tap a gold curb. Expand a departure to see its service date and downstream calls. Mint markers are recently observed vehicles.

- [Version 1 wire types](../contract/src/bus.ts)
- [Importable corridor fixture](../contract/fixtures/bus-corridor-v1.json)
- [Corridor test through the production Worker router](test/corridor.test.ts)
- [Complete M42 example response](../contract/fixtures/m42-scheduled-response.json)

Run the shared verification from either sibling checkout after installing the producer's dependencies.

```sh
pnpm --dir ../nyc-subwhere-bus-producer --filter @nyc-subwhere/bus test
```

The corridor fixture uses Monday, November 23, 2026 in America/New_York. It includes the 08:51, 08:54, and 09:04 departures. At 08:52 the first catchable trip is `20261123/m/catch`. It reaches the downstream stop at 08:59. The test uses the production lookup with fixture assets at the storage boundary.

## Query a curb

1. Get `/api/bus/network`. Supply `after` in epoch milliseconds to select by New York date for a planned trip. The manifest includes `schemaVersion`, `networkVersion`, inclusive service-date coverage, a curb asset URL and shape asset URLs. Retain its version for the calculation. The curb asset includes stop names, coordinates and feed-scoped aliases. Read shapes as GeoJSON FeatureCollections.
2. Get `/api/bus/departures` with `stopId`, `after` and the pinned `networkVersion`. The window is inclusive at `after` and exclusive at `until`. It defaults to one hour and accepts up to 24 hours. `limit` defaults to 10 and accepts 1 through 100. Plan within the manifest's service-date coverage. A known stop with no eligible trips returns an empty page. Unknown stops or releases return 404 and invalid parameters return 400.
3. Send `nextCursor` as the next request's `cursor` with the same version, stop and window. Continue until it is null. Each page uses the first page's observation time and live frame. Live frame history is retained for 15 minutes. On 409, start a new calculation. Sort order is effective boarding time, trip key, then visit sequence.
4. Use `boarding.time` and each downstream call's `time` as absolute Unix milliseconds. A downstream time is the arrival. Its `canAlight` applies to that specific visit. Predicted events carry the source observation time in `observedAt`. Each response's `asOf` is the lookup time. Use the feed, raw trip ID, service date and visit sequence for identity. Use the consumer's own egress and final walk calculations.

This verified schedule-only request returns one eastbound M42 at East 42nd Street and Madison Avenue on Thanksgiving. Its boarding time is `1795713953000`, and the next call at Park Avenue is `1795714020000`. The complete wire response is linked above.

```sh
curl 'http://127.0.0.1:8798/api/bus/departures?stopId=404160&after=1795713300000&until=1795714020000&networkVersion=536bcebd91977b99d5bc'
```

`GET /api/bus/live` accepts the same network pin. It returns updates keyed by trip instance, positions, and per-feed timestamps, last successful fetch, match counts and freshness. `positionsOnly=1` omits update details for map reads. The freshness window for both feed and entity timestamps is two minutes. The poller retains in-force cancellations through the trip's scheduled end. A partial outage preserves the other feed. The departure endpoint handles the overlay and remains usable when Bus Time is unavailable.

## Reproduce the build and previews

From the feature worktree, run these commands with Python 3.10 or later and the repository's pnpm version.

```sh
pnpm install --frozen-lockfile
python3 packages/bus/build_network.py --fetch
pnpm build
pnpm --filter @nyc-subwhere/bus test
```

The importer uses all six official archives. Omit `--fetch` to reproduce a release from existing zip files, or use `--source DIRECTORY`. Each release contains the six SHA-256 archive digests. The version includes the importer and archive contents. Within each feed, GTFS service times remain seconds from service-day zero, including times after 24:00. A common raw curb ID and a single matching location within 25 metres permit cross-feed reconciliation. Conflicting locations retain scoped curb IDs. Regular pickup and drop-off are eligible, while conditional pickup or drop-off requires separate arrangements.

The build writes `packages/web/public/bus-data/<version>/`, validates the JSON assets, then replaces the catalog. The date-selecting manifest keeps the previous quarter active until the new one begins. The deployment workflow archives release assets under immutable versioned keys in the existing Worker KV namespace, publishes the catalog last, and deploys the Worker with archive reads enabled. Earlier pins survive a new Worker deployment. Re-run the build and publication when the MTA changes its schedules.

To use the same schedule-only archive path as the deployment, run from the worktree root:

```sh
python3 packages/bus/publish_network.py --persist-to data/bus-kv
cd packages/worker
./node_modules/.bin/wrangler dev --local --port 8798 --inspector-port 9239 --persist-to ../../data/bus-kv --var BUS_SCHEDULE_ARCHIVE:enabled
```

For live local verification the feature worktree has a mode-0600, gitignored `packages/worker/.dev.vars.bus-live` containing the `BUSTIME_API_KEY` binding. Start the live Worker from `packages/worker` on its own port:

```sh
./node_modules/.bin/wrangler dev --local --port 8797 --inspector-port 9238 --env-file .dev.vars.bus-live --persist-to .wrangler/bus-live
```

Requesting live data or departures wakes the singleton poller. Check `feeds` on `/api/bus/live?positionsOnly=1` after the first poll. For a future hosted activation, run `./node_modules/.bin/wrangler secret put BUSTIME_API_KEY < ~/.secrets/bustimeapikey` from `packages/worker` against the intended deployment. The feature-worktree verification uses local bindings.

## Verification

The November 26 import covered October 12, 2026 through January 2, 2027 and contained 230,532 trips, 7,436,339 stop calls and 13,603 curbs. The schedule-only browser check selected curb 404160, compared the trip, service date and every downstream call against the Worker, then switched to Bike View and back. At 12:33 p.m. New York time, the live Worker reported 3,274 matched trip updates and 1,799 matched vehicle positions, with zero unmatched records in either feed. The live browser check found vehicle MTA NYCT_9771 at its observed coordinates and verified the predicted M42 boarding and all six downstream calls against the direct departure query. To repeat with an installed Chromium binary, set `CHROMIUM_PATH` to its executable and run:

```sh
node packages/web/scripts/check-bus-stop.mjs http://127.0.0.1:8798 404160
BUS_VERIFY_LIVE=1 node packages/web/scripts/check-bus-stop.mjs http://127.0.0.1:8797 404160
```

Use a curb currently served by live buses for the second check. The automated replay covers delay, skipped alighting, cancellation, stale feeds, timeout and incompatible versions. The importer tests publish two quarters, reject an interrupted refresh, distinguish conflicting pole locations, and preserve calendar exceptions, repeated visits and overnight times.

The MTA publishes its [six schedule archives](https://www.mta.info/developers), [quarterly transition guidance](https://www.mta.info/developers/gtfs-schedules-transition), and [Bus Time GTFS realtime interface](https://bt.mta.info/developers/gtfs-realtime).
