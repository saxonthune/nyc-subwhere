---
title: UI requirements
summary: The Board's view-mode UI as a controlled, EARS-like list of shall-statements — Subway, Bike and Bus views, view selection and map inspection — plus the input-command bindings table
tags: [product, requirements, ears, ui, views, bus-view, bike-view, inspector, interaction]
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

- **VW-1.** The Board shows one view at a time and starts in Subway View.
- **VW-2.** Switching views preserves subway polling, position estimation and motion.
- **VW-3.** Subway and Bike views draw from the same baked subway geometry.

## View selection (TG)

- **TG-1.** The bottom-left bar provides view selection between Menu and the update countdown.
- **TG-2.** Selecting a view opens that view and closes the previous view's inspector.
- **TG-3.** Each view control identifies the view it opens.

## Bus View

```yaml rhidoc-feature
prefix: BUSV
name: Bus View
description: Riders can switch to the bus map from the view controls.
```

- **BUSV1.** [p] Bus View is directly selectable to the right of Bike View.
- **BUSV2.** [p] On mobile the Bus View control uses a bus icon.

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

## Train and station inspection

```yaml rhidoc-feature
prefix: INSP
name: Train and station inspection
description: Riders can navigate the map by selecting a train or station in the other's details.
```

### Train identifiers

```yaml rhidoc-feature
prefix: TID
parent: INSP
name: Train identifiers
description: Riders can recognize the same train when moving between a station and that train.
```

- **TID1.** [p] The selected train displays a short, recognizable identifier.

### Stop and arrival lists

```yaml rhidoc-feature
prefix: ILIST
parent: INSP
name: Stop and arrival lists
description: Riders can explore all available predictions in the existing panel footprint.
```

- **ILIST1.** [p] The train panel scrolls through every available upcoming stop within the existing panel size.
- **ILIST2.** [p] The station panel scrolls through every available arriving train within the existing panel size.
- **ILIST3.** [p] Selecting a station in the train's stop list opens that station on the map.

### Station arrival rows

```yaml rhidoc-feature
prefix: AROW
parent: ILIST
name: Station arrival rows
description: Riders can identify an arriving train and follow it from the timetable onto the map.
```

- **AROW1.** [p] Each row shows the same train identifier as the train panel, underneath the arrival time and ETA.
- **AROW2.** [p] Selecting an arrival opens that train on the map.

## Interaction nudge (NG)

- **NG-1.** After a delay from load, the system shall show a banner above the
  row with UI/menu items, styled to read as an informational nudge, with
  content inviting the user to interact with the map.
- **NG-2.** If, before the banner would appear, the user taps a Trip, taps a
  Station, or taps any UI element, the system shall skip showing the banner.
- **NG-3.** Once shown, the system shall dismiss the nudge banner when the user
  taps a Trip, taps a Station, taps any UI element (including the banner
  itself), or when a further delay elapses — whichever happens first.

## Input-command bindings

An **input** is an ordered pair — a target and an interaction method. Each row
binds one input to the command it performs and the requirement it serves.

| Target | Interaction | Action | Req |
|---|---|---|---|
| View control | tap | Open its view and close the previous inspector | TG-2, BV-3 |
| Station or Trip (Subway View) | tap | Open the inspector on it; skip or dismiss the nudge banner | SV-2, NG-2, NG-3 |
| Any UI element, including the nudge banner | tap | Skip or dismiss the nudge banner | NG-2, NG-3 |
| Station, Trip, or line (Bike View) | tap | Nothing | BV-2 |
