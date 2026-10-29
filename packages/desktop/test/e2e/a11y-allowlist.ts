/**
 * Known accessibility findings that are accepted for now. Every entry needs a reason and a way to
 * retire it; more than five means the list has become a place to hide problems and is reviewed.
 * An empty list is the goal and the current state.
 */
export interface A11yException {
  rule: string;
  selector: string;
  reason: string;
}

export const A11Y_ALLOWLIST: readonly A11yException[] = [];

export const MAX_A11Y_EXCEPTIONS = 5;
