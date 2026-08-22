---
title: Citi Bike Poller
summary: A second Durable Object polls the Citi Bike GBFS feeds on the backend's alarm pattern and publishes two frames to KV — status split from station info by change rate, ebike counts disambiguated once at the seam
tags: [architecture, backend, citibike, gbfs, poller, kv, durable-object]
deps: [doc02.04]
---

# Citi Bike Poller

The Worker polls Citi Bike dock state alongside the MTA feeds. A second **Durable Object**,
`BikePoller`, follows the backend's poller shape (doc02.04) — a self-rescheduling 30s alarm,
a fire-and-forget kick from the request path, last-known-good on source failure — and
publishes to the same KV namespace under the `bikes:` key prefix.

## Source

Citi Bike publishes **GBFS** (General Bikeshare Feed Specification) 1.1 feeds at
`https://gbfs.lyft.com/gbfs/1.1/bkn/en/`. No API key. Two feeds are consumed:

- `station_status.json` — per-dock live counts: `num_ebikes_available`,
  `num_bikes_available`, `num_docks_available`, `is_renting`, `is_returning`.
- `station_information.json` — per-dock identity: `station_id`, name, lat/lon, capacity.

Both feeds key on the same `station_id`, so a client joins live counts to identity without
any cross-dataset id mapping.

## Two Frames, Split by Change Rate

- `bikes:snapshot` — the status frame, republished every 30s alarm.
- `bikes:stations` — the identity frame, refreshed hourly inside the same alarm loop;
  docks are installed, moved, and removed on a seasonal cadence, not a live one.

The split keeps names and coordinates out of the frame that ships every poll. The read
path serves `GET /api/bikes` from `bikes:snapshot` with `no-store` and
`GET /api/bike-stations` from `bikes:stations` with `max-age=3600`, and never touches GBFS.

## Contract Out

The response is the app's contract, not raw GBFS. One reshape rule carries the seam's
value: Lyft's `num_bikes_available` **includes** ebikes, so the poller subtracts once and
serves unambiguous counts —

- `ebikes` — `num_ebikes_available`, verbatim
- `classicBikes` — `num_bikes_available − num_ebikes_available`
- `docks` — `num_docks_available`
- `renting` / `returning` — the `is_renting` / `is_returning` flags as booleans; a dock
  can show open slots while refusing returns, so both flags survive the trim

Scooter counts, disabled counts, `legacy_id`, and vendor fields are dropped. The exact
shape lives in the shared contract package (`@nyc-subwhere/contract`).

## Why a Second Poller, Not a Fatter One

`FeedPoller` and `BikePoller` are separate DO classes — split by failure domain and by
state. A GBFS outage cannot throw inside the loop that keeps train state fresh, and the
bike poll carries none of the cross-poll trip memory that defines `FeedPoller`; its only
persisted state is the time of the last station-info refresh. The kick-and-alarm
boilerplate is duplicated rather than abstracted: it is ~20 lines, and the two pollers
share a pattern, not a future.
