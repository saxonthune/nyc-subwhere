---
title: UI requirements
summary: The Board's view-mode UI as a controlled, EARS-like list of shall-statements — Subway View, Bike View, and the toggle — plus the input-command bindings table
tags: [product, requirements, ears, ui, views, bike-view, interaction]
deps: [doc01.01, doc01.03]
---

# UI requirements

The Board's (doc01.01) view-mode capabilities, written as a controlled list of
EARS-style requirements (Easy Approach to Requirements Syntax). Each requirement
has a stable identifier prefixed by its section — `VW-1`, `TG-1`, `BV-1` — so each
section numbers independently; identifiers are never reused once assigned.
Capitalized terms — Station, Trip, Subway View, Bike View — are the glossary's
(doc01.01). The granularity rule of doc01.03 applies: requirements state what and
why, not sizes or radii.

## Views (VW)

- **VW-1.** The system shall render in exactly one of two views — Subway View or
  Bike View — and shall render Subway View at load.
- **VW-2.** Switching views shall change presentation only: polling, position
  estimation, and motion continue unchanged, so Trips keep gliding and nothing is
  re-fetched.
- **VW-3.** Both views shall draw from the same baked geometry — Bike View draws
  the junction-synthesized corridor centerlines the bake already publishes, so
  lines connect through merges and splits and no second geometry asset exists.

## View toggle (TG)

- **TG-1.** The system shall display a view toggle button in the bottom-left bar,
  between the Menu button and the update countdown.
- **TG-2.** When the user presses the view toggle, the system shall switch the
  Board to the other view.
- **TG-3.** The toggle's label shall name the view a press switches to, not the
  view currently shown.

## Subway View (SV)

- **SV-1.** In Subway View the system shall render the presentation doc01.03
  describes: full-width track ribbons, Station pucks, Trips as elongated boxes.
- **SV-2.** In Subway View the system shall open the inspector on a Station or
  Trip tap, per doc01.03 Inspector.

## Bike View (BV)

- **BV-1.** In Bike View the system shall render the network's lines thin,
  Stations small, and each Trip as a small disc, so the subway reads as context
  rather than subject.
- **BV-2.** In Bike View the system shall not respond to taps on lines, Stations,
  or Trips, and shall not open the inspector.
- **BV-3.** When the Board enters Bike View, the system shall close any open
  inspector panel.

Bike View exists to clear the stage for cycling-oriented information; what that
information is belongs to its own doc, not this one.

## Input-command bindings

An **input** is an ordered pair — a target and an interaction method. Each row
binds one input to the command it performs and the requirement it serves.

| Target | Interaction | Action | Req |
|---|---|---|---|
| View toggle | tap | Switch to the other view; close any open inspector | TG-2, BV-3 |
| Station or Trip (Subway View) | tap | Open the inspector on it | SV-2 |
| Station, Trip, or line (Bike View) | tap | Nothing | BV-2 |
