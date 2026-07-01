---
title: Overview
summary: The runtime model — pull-snapshot the feed, interpolate between keyframes; backend fetch loop and the (open) front-end
tags: [architecture, overview, realtime, fetch-loop, interpolation]
deps: [doc02.02, doc01.01]
---

# Overview

How the app turns MTA's feed into live motion. Two moving parts: a **backend fetch loop** that
pulls the **Feed** (doc02.02) on an interval, and a **front-end** that renders **Position
Estimate**s onto the **Board**. The terms are the glossary's (doc01.01).

## Runtime Model: Pull Snapshots, Interpolate Between Them

MTA is pull-only — there is no webhook, subscription, or push. Each per-line endpoint returns a
GTFS-realtime `FeedMessage` that is a **complete snapshot** of current state (every active Trip,
its remaining Stop Time Updates, plus Vehicle Positions and Alerts), not a delta. You `GET` it,
parse it, and hold the whole world; the next `GET` replaces it.

Two clocks that are easy to conflate:

- **Trip Replacement Period (30 min)** — how far *ahead* a snapshot predicts. Stop Time Updates
  only cover stops within ~30 minutes; trips further out are absent. Bounds prediction range, not
  freshness.
- **Regeneration cadence** — how often MTA rebuilds the snapshot (order of ~30s). This bounds
  freshness. Polling faster returns identical bytes; you cannot beat MTA's rebuild rate.

Freshness is therefore capped by MTA. **Smoothness is not**: between polls the front-end advances
each Trip's Position Estimate along its Segment by wall-clock time. The feed supplies keyframes;
interpolation renders the tween. This is the core trick — the train glides even though the data
under it steps every ~30s.

## Backend: Fetch Loop

A worker (not the browser — CORS, protobuf decoding, and one shared cache argue for a server
seam) owns the pull:

- Polls only the line-feeds the current view needs, on a conservative interval (~15–30s; MTA
  pins no rate limit beyond the 30-minute horizon).
- Sends conditional requests (`If-Modified-Since` / `ETag`) so an unchanged snapshot returns
  `304` and costs nothing.
- Decodes the protobuf `FeedMessage`, filters to live Trips (NYCT `is_assigned`), and exposes the
  parsed Trips + Stop Time Updates + Alerts to the front-end in a browser-ready shape.
- Serves the front-end too: one **unified Worker** hosts the built static assets (via Workers
  Static Assets) *and* the `/api` route, so the front-end calls its data source same-origin with
  no CORS and the whole app ships in one deploy. (Backend seam: doc02.04.)

Turning the parsed feed into a Position Estimate — interpolating between two Stop Time Updates
along a Segment — is shared logic that reads from the contract (`@nyc-subwhere/contract`).

## Front-End: Website

The front-end (doc02.03) renders the Board and animates Position Estimates between polls, reading
the Worker's `/api` responses against the shared contract (`@nyc-subwhere/contract`).
