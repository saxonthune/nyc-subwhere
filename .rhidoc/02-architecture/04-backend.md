---
title: Backend
summary: Cloudflare Worker backed by a single Durable Object that polls the MTA feeds on a 30s alarm and publishes the reshaped frame to KV — fan-in, alert-key custody, insulation, and reshape-once
tags: [architecture, backend, cloudflare, worker, durable-object, kv, poller]
deps: [doc02.02, doc02.01]
---

# Backend

A Cloudflare Worker sits between the front-end and the MTA **Feed** (doc02.02). A single
**Durable Object** polls every feed on a 30s alarm loop, reshapes the result against a cross-poll
memory, and publishes the finished frame to **KV**. The request path (`/api/trips`) reads that
frame straight from KV and never decodes a feed. The runtime model it serves is doc02.01.

## Why a Seam At All

Direct device-to-MTA polling is technically viable — the feeds need no auth and send
`Access-Control-Allow-Origin: *`. The Worker earns its place for reasons other than access:

- **Fan-in.** Each raw per-line snapshot is the full protobuf blob (every active Trip with its
  whole remaining stop list). N devices polling direct is N× that download and N residential IPs
  hitting MTA on a tight interval — a throttle/block risk for the whole userbase. The poller
  collapses that to ~one MTA request per feed per 30s window.
- **Alert-key custody.** The camsys **Alert** feeds require an API key (doc02.02) that cannot ship
  in a browser. The Worker is the only place it can live.
- **Insulation.** An MTA endpoint change or outage is fixed in one place and can serve
  last-known-good, instead of breaking every client at once with no hotfix.
- **Reshape once.** protobuf → renderer contract is computed once per window, not on every device
  every poll.

## A Single Poller, Not Per-Request Decode

Two platform limits decide the shape:

- The Workers free plan caps CPU at 10 ms per invocation — fetch handler and Cron Trigger alike.
  Decoding all eight protobuf feeds and reshaping exceeds that, so the decode cannot sit on the
  request path (it exhausts CPU and returns 503) nor in a cron handler.
- Cron Triggers have a one-minute floor; the feeds regenerate every ~30s, so a minute is too
  stale.

So the decode runs in a Durable Object with a self-rescheduling `alarm()` that fires every 30s,
fetches the feeds, reshapes, and writes the frame to KV. Being one instance, its cross-poll memory
— the snapshot-diffing that recovers each Trip's departed stop and detects stalls — is a single
coherent history; per-request decoding gave each edge isolate its own copy, so the diffs
disagreed. The memory is persisted to DO storage so it survives eviction between alarms.

A front-end request reads the last published frame from KV and, fire-and-forget, kicks the poller
awake if it has idled. The alarm reschedules itself, so the loop is self-sustaining once started;
the kick only bootstraps the first run after a deploy. Before the first frame is published the
read path returns an empty frame, which the front-end renders as "no trains" and clears on its
next poll.

The Durable Object and KV together require the Workers Paid plan.

## Contract Out

The Worker's response is the renderer's contract, not raw GTFS-realtime: live Trips (NYCT
`is_assigned`) with the fields the Board needs, already decoded from protobuf and filtered.
The exact shape is the shared contract package (`@nyc-subwhere/contract`).
