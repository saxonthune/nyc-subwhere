---
title: Backend
summary: Cloudflare Worker as a read-through edge cache in front of the MTA feeds — fan-in, alert-key custody, insulation, and reshape-once
tags: [architecture, backend, cloudflare, worker, cache, fetch-loop]
deps: [doc02.02, doc02.01]
---

# Backend

A Cloudflare Worker sits between the front-end and the MTA **Feed** (doc02.02) as a
**read-through edge cache**. It is not a background poller writing to a bucket: it fetches MTA
on a cache miss, holds the result at the edge for one regeneration window, and serves every user
in that window from cache. The runtime model it serves is doc02.01.

## Why a Seam At All

Direct device-to-MTA polling is technically viable — the feeds need no auth and send
`Access-Control-Allow-Origin: *`. The Worker earns its place for reasons other than access:

- **Fan-in.** Each raw per-line snapshot is the full protobuf blob (every active Trip with its
  whole remaining stop list). N devices polling direct is N× that download and N residential IPs
  hitting MTA on a tight interval — a throttle/block risk for the whole userbase. The Worker
  collapses that to ~one MTA request per window.
- **Alert-key custody.** The camsys **Alert** feeds require an API key (doc02.02) that cannot ship
  in a browser. The Worker is the only place it can live.
- **Insulation.** An MTA endpoint change or outage is fixed in one place and can serve
  last-known-good, instead of breaking every client at once with no hotfix.
- **Reshape once.** protobuf → renderer contract is computed server-side once per window, not on
  every device every poll.

## Read-Through Cache, Not a Cron Poller

Cloudflare Cron Triggers have a one-minute floor — too slow for the ~30s feed regeneration. So
the Worker does not loop in the background. Instead, on each front-end request:

1. Look up the parsed result in the edge cache (Cache API / KV), keyed by line-feed.
2. On hit within TTL, serve it. On miss, fetch MTA, decode, trim, store with a short TTL
   (~20–30s, matched to regeneration — see doc02.02), then serve.

A background authoritative poller or history store (a Durable Object alarm to poll sub-minute, or
a bucket of past snapshots) is added only if the front-end needs history — e.g. smoothing a
Position Estimate across snapshots. Absent that need, the read-through cache is the whole backend.

## Contract Out

The Worker's response is the renderer's contract, not raw GTFS-realtime: live Trips (NYCT
`is_assigned`) with the fields the Board needs, already decoded from protobuf and filtered.
The exact shape is the shared contract package (`@nyc-subwhere/contract`).
