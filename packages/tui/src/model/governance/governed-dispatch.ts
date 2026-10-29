/**
 * `isGovernedDispatch` - the one predicate that says whether a team dispatch belongs to a
 * governed run (governance-mode section 10.4, RV-3).
 *
 * Pure: no React, no I/O. ASCII ONLY (`governance/` is glyph-scanned).
 *
 * WHY A FUNCTION AND NOT AN INLINE FIELD CHECK. The reducer's `teamStart` must keep a
 * governed dispatch out of the transcript (one run is 10-20 dispatches; a `TeamCard` for
 * each would bury the conversation) while writing the live `state.team` snapshot the
 * panel and `/agents` read. Two call sites need the same answer (the reducer and, later,
 * the card tests), and "does any spec carry governance" is exactly the kind of check that
 * grows a second spelling. The reducer imports ONLY this function.
 */

/** The structural slice of a `SubagentSpec` this predicate reads. */
export interface GovernedSpecLike {
  governance?: unknown;
}

/** True when ANY spec of the dispatch is governed (a governed stage is homogeneous). */
export function isGovernedDispatch(specs: readonly GovernedSpecLike[]): boolean {
  return specs.some((spec) => spec.governance !== undefined);
}
