---
title: Position Estimation
summary: How accurately a train's position can be recovered from the realtime feed — the one hard fact per poll, the observed events diffing manufactures, the interpolation formula, where delays make position unknowable, and how to fold each new frame into the position already shown (forward-only reconciliation) instead of recomputing it and snapping the train backward
tags: [architecture, realtime, interpolation, motion, position, prediction, dead-reckoning, research]
deps: [doc02.02, doc02.01]
---

# Position Estimation

Research notes on the accuracy ceiling for a train's rendered position, given only
what the MTA realtime feed carries (doc02.02). This describes the estimation
*problem* and the model that answers it — not any particular backend. It is a
reference for reasoning about motion, independent of how a given worker or client
happens to place trains.

## What the feed gives

Per Trip, per poll (~30s):

- A **Trip Update**: an ordered list of `(stopId, arrivalTime, departureTime)` for
  the stops *ahead*. Passed stops are pruned. The times are **predictions**.
- A **Vehicle Position** (measured: ~91% of Trips carry one): `(stopId,
  currentStatus, timestamp)`, where `currentStatus ∈ {STOPPED_AT, IN_TRANSIT_TO,
  INCOMING_AT}`. There is **no coordinate** — NYCT does not populate the
  position's lat/lon (measured: 0%).

This yields exactly **one hard positional fact** per Trip per poll:

> at `timestamp`, the train is *{at | approaching}* `stopId`.

Everything else is prediction. Measured prediction quality: the median predicted
arrival is stable across a poll (p50 shift = 0s), but the tails are large —
roughly a fifth of stop-predictions move by more than 10s per 30s poll, up to
±40s, symmetric (no consistent lateward drift). So the arrival times are usable
as a rough pace but must not be treated as a precise, stable target.

## Observed events from diffing

The single fact becomes a stream of trustworthy *events* by diffing `currentStatus`
across consecutive polls. Each time the referenced stop advances, the train has
provably passed the earlier stop within one poll window:

```
poll N       poll N+1          observed (hard, ±½ poll)
────────────────────────────────────────────────────────
ref = A      ref = B      →    train left / passed A in (t_N, t_{N+1}]
in_transit   stopped_at B →    train reached B in (t_N, t_{N+1}]
```

These pass-events are the anchors worth building on — far more reliable than any
predicted time. The deltas worth deriving from them:

- **observed pass time** at each stop: the poll where the reference advanced past it;
- **observed segment travel time**: the interval between two consecutive pass
  events — the train's *demonstrated* speed on the segment just completed;
- **non-progress**: the reference stop not advancing while its predicted arrival
  slips later — a stall.

Dwell shorter than the poll interval can hide a `STOPPED_AT` sighting, so the
robust event is "the referenced stop advanced," which holds whether or not the
stop was caught. Median dwell is ~0s with a tail to ~30s+ (measured), so most
stops are passed, not rested at.

## The interpolation

Position is one-dimensional — distance along the Track (doc02.01). Between the
stop behind (A, observed passed) and the stop ahead (B, not yet observed):

```
dist(now) = dist(A) + (dist(B) − dist(A)) · clamp01( (now − t_leftA) / (t_reachB − t_leftA) )
```

with `dist(·)` from the baked linear-reference index (doc02.01). All accuracy
lives in the two times:

- **`t_leftA` — the observed departure.** The pass-event timestamp, taken as the
  *midpoint* of the window in which it must have occurred (≈ the detecting poll
  minus half a poll), not the detecting poll itself. Anchoring on the detecting
  poll places departure ~½ poll late, which renders the train persistently behind
  by that much travel — a systematic rear bias of a few hundred meters at express
  speed.

- **`t_reachB` — committed once, at departure.** Freeze the predicted arrival to B
  *as it stood when A was left*, and interpolate against that frozen time for the
  whole segment. Re-reading the arrival each poll injects the prediction's tail
  jitter directly into position. When B is *observed* reached, snap the rear
  anchor to B (a small correction) and begin B→C fresh.

This is **dead-reckoning between observed anchors**: a segment-appropriate glide,
corrected only by hard observation, never yanked by prediction noise.

### Pacing alternatives for `t_reachB`

Two estimators of the frozen travel time `t_reachB − t_leftA`:

1. **Committed feed prediction** — `arrival(B) − t_leftA` at departure. Encodes
   express-vs-local segment length directly; simplest.
2. **Observed speed** — `dist(A→B) / v`, where `v` is the demonstrated speed of
   the previous segment(s). Self-calibrates to a train currently running slow.

Both are consistent with the model; they differ only in how `t_reachB` is
seeded. A blend (feed prediction, corrected by a slow-running observation) is the
richer form.

## Delays: the boundary of what is knowable

During a delay the train is stuck *somewhere* on A→B. With no coordinate, its
exact position **is not in the data**. Two things remain recoverable:

- **Detection** — the reference stop stops advancing while its predicted arrival
  slips later. A reliable "not progressing" signal.
- **Bounds** — the train was observed to leave A and has *not* been observed to
  reach B, so it is provably in the open interval (A, B).

The honest rendering follows from refusing to assert an unobserved arrival. If
the committed `t_reachB` passes with no observed arrival at B, the estimate must
**not** clamp onto B — that would claim an arrival never seen. It holds the train
short of B and marks it uncertain (doc01.03, "Uncertain Position"). This is the
"held near the next station, blinking" state: the model knows the segment and
knows the train is late, but not the point, and says so rather than fabricating
precision.

So: position is predictable while a train runs at a steady demonstrated pace, and
during a delay only the *segment* and the *fact* of the delay are predictable, not
the point. Pinpointing a stalled train is predicting data the feed does not carry;
the model's task there is to represent the uncertainty, not paper over it.

## Reconciling successive frames

Everything above places a train from *one* frame. But frames arrive every ~30s and
the rendered train persists between them, so each new frame meets a train already
on screen. Recomputing absolute position from the new frame's anchor and predicted
ETA — as if from nothing — turns ETA jitter into position jitter: when the predicted
arrival to B slips later, the ratio `(now − t_leftA)/(t_reachB − t_leftA)` shrinks,
so the *same train at the same instant* reads as **less** far along and snaps
backward toward A. Then the ETA firms up and it lurches forward. A train never
reverses; the rendering must not either.

The fix is to treat a new frame as a **correction to the position already shown**,
not a fresh computation. Carry one number per Trip — `d_shown`, the distance last
rendered — and on each frame re-base the glide to start from where the train is:

```
from_dist = min( max(d_shown, dist(Lo)), dist(B) − ε )      // never backward; never past B
from_t    = now
to_dist   = dist(B) − ε                                       // the hold-short cap
to_t      = t_reachB
dist(now) = from_dist + (to_dist − from_dist) · clamp01((now − from_t)/(to_t − from_t))
```

where `Lo` is the last **observed** station (hard fact) and `B` the next station,
approached but unobserved. This is continuous by construction: at the instant of
re-basing, `from_dist = d_shown`, so the position does not move — only its future
*slope* (the pace to hit the new ETA) changes. Its properties:

- **Monotonic forward.** `from_dist ≥ d_shown`, so the render never rewinds; a
  delay becomes *deceleration* (a later `to_t` flattens the slope), not a jump back.
- **Observation snaps forward.** When the reference advances so `dist(Lo)` moves
  ahead of `d_shown`, `max` jumps the train forward onto the newly confirmed
  station — a forward release, never a backward yank.
- **Honesty preserved.** Capped at `dist(B) − ε`; past `to_t` with no observed
  arrival it holds short and blinks, exactly as the single-frame model does.

The correction the fold has to absorb — `d_shown` versus the new frame's own
placement — is the honest measure of how wrong the extrapolation was, and shrinks
as the model improves.

This is a first-order fold: `d_shown` already summarizes every prior frame, so
**continuity needs state, not a window** — no buffer of past frames is required.
A short history of pass-events is still worth keeping, but for two *independent*
jobs: seeding the pace `v` from demonstrated speed, and detecting the arrival-slip
that flags a stall. Neither is needed for the continuity fold itself.

## Formulae, collected

- **Position**: `dist(now) = dist(A) + (dist(B) − dist(A)) · clamp01((now − t_leftA)/(t_reachB − t_leftA))`
- **`t_leftA`** = midpoint of the poll window in which the reference advanced past A ≈ `t_detect − ½·pollInterval`
- **`t_reachB`** = `t_leftA + T̂`, with committed travel time `T̂` seeded at departure by either
  - feed: `T̂ = arrival(B)|_{t_leftA} − t_leftA`, or
  - observed speed: `T̂ = dist(A→B) / v`, `v` = demonstrated speed of prior segment(s)
- **Observed segment speed**: `v_{A→B} = (dist(B) − dist(A)) / (t_reachB^obs − t_leftA^obs)`, from two pass-events
- **Stall**: reference stop unchanged for ≥ K polls **and** predicted arrival slipped later by a comparable margin
- **Uncertain render**: `now > t_reachB` with no observed arrival at B ⇒ hold at `dist(B) − ε`, blink
- **Frame reconciliation**: `dist(now) = from_dist + (dist(B) − ε − from_dist)·clamp01((now − from_t)/(t_reachB − from_t))`, with `from_dist = min(max(d_shown, dist(Lo)), dist(B) − ε)` and `from_t = now` at the re-base

The recurring theme: anchor on observations, dead-reckon between them at a
committed pace, never render past the last observation, and fold each new frame
into the position already shown rather than recomputing it from scratch.
