---
title: Glossary
summary: Load-bearing domain vocabulary — GTFS-anchored terms, the project's own coined terms, and the ambiguities to watch
tags: [product, glossary, vocabulary, gtfs]
deps: [doc01.02]
---

# Glossary

The shared vocabulary is the highest-fan-out artifact in the project: every doc, type,
component, and file inherits it. Per doc01.02, the human ratifies these names; the agent
proposes and flags. Terms below marked **(proposed)** are unratified.

## Naming Principle

Anchor to the external data contract first. Where MTA's GTFS / GTFS-realtime feed already
names a concept, reuse that name verbatim rather than coining a synonym — an externally-anchored
name cannot drift and cannot be quietly re-authored. Coin a new term only for concepts the feed
has no word for (the visualization and the position estimate), and flag every coined term.

## GTFS-Anchored Terms

These carry their GTFS meaning; the purpose line says why the project cares. The
parenthetical names the feed identifier or entity to anchor to.

- **Route** — a labeled service (the `1`, the `A`, the `G`). What a rider names when they name
  a train. GTFS `route` (`route_id`).
- **Trip** — one run of one train along a route in one direction. The unit the feed tracks over
  time; the thing whose position the app estimates. GTFS `trip` (`trip_id`).
- **Stop** — a single platform where a train halts. GTFS `stop` (`stop_id`); position source for
  segment endpoints. In the NYCT feed the `stop_id` carries a direction suffix (`N`/`S`), so
  the two platforms of a Station are two distinct `stop_id`s.
- **Station** — the passenger-facing place, grouping the stops on both directions/platforms.
  GTFS parent `stop` (`parent_station`). **Distinct from Stop** — split by: a Station contains
  many Stops.
- **Trip Update** — a GTFS-realtime `TripUpdate` entity: one Trip's schedule of predictions,
  holding a Stop Time Update for each of its remaining Stops. The container the position estimate
  reads from.
- **Stop Time Update** — a GTFS-realtime `StopTimeUpdate` (inside a Trip Update): a prediction
  that a Trip reaches a given Stop at a given `arrival`/`departure` time. The primary signal the
  position estimate is derived from.
- **Vehicle Position** — a GTFS-realtime `VehiclePosition` entity: a Trip's location as a
  `current_status` (`INCOMING_AT` / `STOPPED_AT` / `IN_TRANSIT_TO`) against a `stop_id` /
  `current_stop_sequence`. The NYCT subway feed expresses position relative to a Stop, **not** as
  lat/lon; a stronger position signal than Stop Time Update where present.
- **Alert** — a GTFS-realtime `Alert` entity: an `informed_entity` (Route / Stop / Trip),
  `active_period`, `cause`, `effect`, and `header_text` / `description_text`. Carries service
  disruptions and, in the realtime feeds, train-`delayed` flags. (Feeds and shape: doc02.02.)
- **Feed** — an MTA GTFS-realtime `FeedMessage`: a stream of `FeedEntity`, each one a Trip Update,
  Vehicle Position, or Alert. The source signal. (Fetching and contract: doc02.02.)

## NYCT Extension Terms

The NYCT subway feed carries a custom extension (`nyct-subway.proto`, `NyctTripDescriptor` /
`NyctStopTimeUpdate`) beyond stock GTFS-realtime. These fields are subway-specific.

- **train_id** — the NYCT identifier for a physical train, distinct from `trip_id`. Encodes
  origin/destination and the line.
- **is_assigned** — whether a Trip is backed by a real tracked train (`true`) or is a schedule
  placeholder not yet running (`false`). Filter for live trains.
- **direction** — NYCT compass direction (`N`/`S`), redundant with the `stop_id` suffix but
  supplied directly on the trip descriptor.
- **scheduled_track / actual_track** — the platform track a Trip is booked for vs. the one it is
  actually using, per Stop Time Update.
- **Trip Replacement Period** — the horizon (30 minutes, all routes) beyond which the realtime
  feed carries no Trip Updates. Bounds how far ahead the app can predict.

## Coined Terms (proposed)

Concepts the feed has no name for. These are the load-bearing ones to ratify first.

- **Segment (proposed)** — the stretch of track between two adjacent Stops on a Trip's path. The
  domain over which position is interpolated; a Trip is always "on" exactly one Segment.
- **Position Estimate (proposed)** — a Trip's location expressed as a fraction along its current
  Segment (0 at the previous Stop, 1 at the next). The core computed output of the app.
- **Board (proposed)** — the tron-like black canvas the network is drawn on. The single visual
  surface. *(Placeholder name — surface, canvas, map, and grid are alternatives.)*

## Ambiguity Watch

Names that blur two concepts, per the DA-RESULTS naming discipline (doc01.02). Resolve before
these spread:

- **Train** — colloquially means both a Route ("take the A train") and a Trip ("the train is
  two stops away"). Load-bearing overload. Candidate resolution: reserve **Route** and **Trip**
  for code/docs and let "train" live only in user-facing copy.
- **Line vs Route** — "line" (the physical trunk, e.g. the IND Eighth Avenue Line) is not the
  same as "route" (the service). Pick one for the service concept; **Route** is proposed.
- **Position** — the interpolated **Position Estimate** vs a raw feed **Vehicle Position**.
  Keep the qualifier; never bare "position".
