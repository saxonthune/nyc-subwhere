// Shared between build-streets.ts (which enforces it) and qa-streets.ts
// (which verifies it), so the check can't drift from the bake.
//
// No baked street segment may exceed this length (meters). Extract chords —
// a way whose nodes outside the BBBike extract polygon were dropped, joining
// the survivors with one long straight segment — are detected by exactly this:
// a raw segment longer than any real one. Empirically (scan of raw segments
// whose endpoints both land on the kept boroughs), legit segments top out at
// 1.81 km (Manhattan Bridge spans) and chords start at 2.63 km, so 2200
// splits the gap. Simplification is capped to the same length so the bake
// output keeps the invariant checkable.
export const CHORD_SPLIT_M = 2200;
