---
title: Development Ethos
summary: How this project is built with an agent — lessons carried from the FIFA-bracketing DA-RESULTS retrospective
tags: [product, process, ethos, naming, human-agent]
deps: [doc01.01]
---

# Development Ethos

Lessons carried from a prior human–agent build (the FIFA-bracketing `DA-RESULTS`
retrospective). Its single finding: the process was fast, but the largest tax was language —
the agent silently authored the vocabulary, and every downstream artifact inherited weak,
overloaded names that then had to be renamed under load. The rules below exist so that tax is
not paid again here.

## The Core Rule

The human owns the upstream layer; the agent executes downstream. Names, scope, abstractions,
and this process itself are the human's to price. A new term, module, feature, or concept-verb
is the most load-bearing decision there is — the agent surfaces it as a decision, never
silently commits it.

The failure mode to guard against: "keep the agent busy" licenses the agent to fill every
vacuum, including the vacuums that were the human's decisions to make.

## Glossary-First

The glossary (doc01.01) is ratified before anything fans out — no types, no components, no
research tasks build on an unratified name. It is the first design rule, not a backfill.
Anchor names to the external contract (GTFS) where one exists; coin and flag only what the
contract can't name.

## Naming Is Halt-and-Confirm

Reaching for a name — a type, a surface, a file, a module, an abstraction — is a **stop**, not
a silent commit. Before locking a domain name, check it is:

- **Distinct** from every existing term, and
- **Specific enough to stand alone** out of context.

Flag the name and propose alternatives if it blurs two concepts, is short and generic, or is
overloaded. The overloaded name is a standing trap, not a one-time slip: it bites again every
time the concept is discussed. (Watched overloads live in doc01.01.)

## Altitude Before Peers

Decide where a concept sits before building it. A feature computed *on top of* existing data is
a downstream layer, not a peer of the data it consumes — placing it as a peer lets it corrupt
the definitions below it. Settle layer-vs-peer as part of naming, against the actual data flow.

## One Contract Surface

The contract is the glossary (names + intent) plus the types (shapes, once). No per-shape
contract-doc tree — a doc that only points at a type says nothing the type doesn't, and every
rename then has to fan out across three places instead of one.

## Nothing Load-Bearing Enters Unauthorized

No conjured files, no agent-coined task slugs, no abstraction that appeared without a decision.
Task slugs are vocabulary too and inherit the naming bar.

## Decision Log Bar

Record only load-bearing design rules — high `fan-out × irreversibility`. Not every change,
correction, or rename. A wrong-then-fixed decision shows the current rule or nothing, never the
wobble.
