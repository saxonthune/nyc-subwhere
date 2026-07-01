---
title: MTA Resources
summary: Where subway data comes from, its contract and shape, and the fetch decisions still open
tags: [architecture, mta, gtfs, data-source]
deps: [doc01.01]
---

# MTA Resources

The data contract behind the glossary terms (doc01.01): what MTA publishes for the subway, in
what shape, and how the app pulls it. Feed identifiers and field names discovered here anchor the
glossary's GTFS-anchored terms.

## What This Answers

- Where the realtime **Feed** lives, and what shape it arrives in.
- Where the static network geometry lives (Stop coordinates, Route paths) that a **Segment**
  and a **Position Estimate** are computed against.
- What the app must do at runtime to keep a live view current.

## Findings

Source and access:
- The subway realtime **Feed** is GTFS-realtime protobuf, grouped into per-line endpoints (see
  Resources). Each endpoint returns a `FeedMessage` whose entities are Trip Updates, Vehicle
  Positions, and Alerts.
- Subway realtime endpoints need **no API key**. The camsys **Alert** feeds do need a key and
  additionally offer a `.json` variant.

Contract and shape:
- The subway feeds carry all three entity types — **Trip Update**, **Vehicle Position**, and
  **Alert**. Vehicle Position gives location relative to a Stop (`current_status` against a
  `stop_id`), not lat/lon, so the Position Estimate leans on **Stop Time Update** timing.
- The feed's prediction horizon is the **Trip Replacement Period** — 30 minutes; no Trip Update
  reaches further ahead than that.
- Static GTFS (Stop lat/lon, Route/shape geometry) comes from MTA's static GTFS bundle
  (mta.info / data.ny.gov). A realtime Trip joins static geometry by `route_id` and `stop_id`.

## Open — App Decisions

Not facts about the feed; choices the app still owns:
- Does the browser fetch the Feed directly, or does a proxy/worker sit between (CORS, protobuf
  decoding)? Note: `stop_id`/`route_id` join reliably, but NYCT realtime `trip_id`s do not match
  static `trip_id`s directly — resolve the join before relying on it.
- The exact poll cadence / any rate limit is not pinned by MTA docs beyond the 30-minute horizon;
  pick a conservative refresh interval.
- How the raw feed becomes a **Position Estimate** — interpolating between two **Stop Time
  Update**s along a **Segment**.

## Constraints

Findings feed the glossary and one types surface, per the one-contract-surface rule (doc01.02).
Names discovered here (feed identifiers, field names) anchor the glossary's GTFS-anchored terms —
reuse the feed's own vocabulary rather than coining synonyms.

## Resources

MTA developer entry points and the specs behind the glossary terms.

- [MTA Developer resources](https://www.mta.info/developers) — hub for all feeds (realtime,
  static GTFS, alerts) and their docs.
- [GTFS-realtime Reference for the NYC Subway](https://www.mta.info/document/134521) — the
  authoritative field-level contract, including the NYCT extension (`NyctTripDescriptor`,
  `NyctStopTimeUpdate`) and the Trip Replacement Period.
- [Subway realtime feeds API portal](https://api.mta.info/#/subwayRealTimeFeeds) — the feed
  index; no API key required for subway realtime.
- Realtime feed endpoints (protobuf `FeedMessage`), grouped by line:
  - A C E H (Rockaway/Franklin shuttles): `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace`
  - B D F M: `…/nyct%2Fgtfs-bdfm`
  - N Q R W: `…/nyct%2Fgtfs-nqrw`
  - 1 2 3 4 5 6 7 + 42 St shuttle: `…/nyct%2Fgtfs`
  - G / J-Z / L / SIR: separate `…/nyct%2Fgtfs-g`, `-jz`, `-l`, `-si` endpoints.
- Service **Alert** feeds (camsys, GTFS-realtime; `.json` variant available, API key required):
  `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys/subway-alerts`
- [GTFS-realtime spec reference](https://gtfs.org/documentation/realtime/reference/) — stock
  `TripUpdate` / `VehiclePosition` / `Alert` definitions the NYCT extension builds on.
- [nyct-gtfs](https://github.com/Andrew-Dickinson/nyct-gtfs) — reference parser; useful for
  seeing which fields the subway feed actually populates.
