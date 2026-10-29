/**
 * `@aragon-agent/tui` - the terminal runtime of AragonAgent.
 *
 * This entry deliberately exports ONE constant and has no side effects. It is NOT a barrel,
 * and must not become one: Ink caches its CI detection the first time `ink` is imported,
 * and `ui/ink-runtime` has to be evaluated before any other module that imports Ink. A
 * barrel that re-exported the components would make that order depend on import sort order.
 * Consumers import the module they need by its subpath instead, for example
 * `@aragon-agent/tui/ui/ink-runtime` or `@aragon-agent/tui/ui/theme`.
 */
export const TUI_API_VERSION = 1 as const;
