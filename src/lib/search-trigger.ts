// When typing should actually fire a search.
//
// Every auto-fired search costs one Voyage embedding, and the free tier allows
// 3 requests per minute. At the old 300ms debounce a single thoughtful query
// spent that budget before the user finished the sentence: nl_query_log shows
// 22% of all searches were abandoned prefixes, e.g.
//   "cozy" -> "cozy date" -> "cozy date in" -> "cozy date in cap" -> "cozy date in capi"
// Five embeddings, one intent. When the budget runs out /api/search falls back
// to filter-only ranking, so the user still gets results — just not semantic
// ones, and nothing on screen says so.
//
// Two rules, both bypassed by an explicit submit (Enter or the button), because
// pressing Enter is unambiguous intent and should never be second-guessed.

/** Wait this long after the last keystroke before auto-searching. */
export const SEARCH_DEBOUNCE_MS = 800;

/**
 * Below this length a query is almost certainly mid-word ("es", "quiet roo").
 * Real examples from the log; none of them were what the user meant.
 */
export const MIN_AUTO_SEARCH_CHARS = 4;

/**
 * Should this input fire a search on its own, without an explicit submit?
 *
 * Clearing the box always counts: an empty query resets the view and costs no
 * embedding (the route skips embedding when the query is empty), so it must
 * never be swallowed by the length rule.
 */
export function shouldAutoSearch(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return true;
  return trimmed.length >= MIN_AUTO_SEARCH_CHARS;
}
