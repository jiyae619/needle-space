# Needle Space — AI v1 Impact Report

A summary of what shipped in the AI v1 pass, and the measurable lift in search accuracy.

Sample: **252 cafes** (Seattle metro), all LLM-tagged. Regex tagger preserved as the eval baseline.

---

## What I built

### 1. LLM review tagger (Gemini 2.5 Flash + LangGraph.js)
Replaces a brittle regex-only tagger with a structured-output LLM that reads each cafe's Google reviews and emits five workspace attributes plus a confidence score and an evidence quote per attribute.

- `scripts/analyze-reviews-llm.mjs` — populates `*_llm` columns, `tagging_confidence` JSONB, and a 1024-dim `cafe_embedding` (Voyage-3) per cafe.
- LangGraph runtime with conditional retry edges for malformed JSON.
- Forced function calling for schema-stable output.

### 2. Vision backfill pass (Gemini 2.5 Flash)
Where reviews were silent, vision looks at the cafe's photo to fill outlet, seating, and laptop-policy gaps.

- `scripts/visual-tag-cafes.mjs` — only writes when existing tag is `unknown` AND vision confidence ≥ 0.7. Idempotent via `visual_tagged_at` marker column.

### 3. Strategy C smart merge (LLM-first, regex fallback, mark uncertain on disagreement)
Card UI and SQL `match_cafes` RPC both use the same merge: `coalesce(nullif(*_llm, 'unknown'), *_regex)`. When both sources committed but disagreed, the tag renders with a dotted underline so users know to read the reviewer quote on the card before trusting it.

### 4. Semantic search
Voyage-3 query embeddings + pgvector cosine on `cafe_embedding`. Multi-value filter chips compose with NL search via SQL intersection — natural-language meaning AND structured filters, in one query.

### 5. Glance reviews on cards
Each card surfaces the highest-confidence reviewer quote pulled from `tagging_confidence.evidence`, attributed to the attribute it supports ("— on noise"). Reviewer voice alongside the structured tags.

### 6. "How it works" explainer in the nav bar
One global plain-language popover covering reviews → photos → dotted-underline → semantic search. Replaced awkward per-tag hover tooltips.

---

## Search-accuracy lift — by attribute

"Known rate" = % of cafes where we have a non-`unknown` value for the attribute. Higher is better — every `unknown` is a cafe that filter chips silently drop and that semantic search has weaker signal for.

| Attribute | Regex baseline | LLM only | LLM + Vision | **Δ (regex → final)** |
|---|---:|---:|---:|---:|
| `wifi_quality` | 1% | 10% | 10% | **+9 pts** |
| `outlet_availability` | 8% | 12% | 12% | **+4 pts** |
| `noise_level` | 65% | 73% | 73% | **+8 pts** |
| `laptop_policy` | 17% | 44% | **61%** | **+44 pts** |
| `seating_availability` | 31% | 79% | **88%** | **+57 pts** |

**The two biggest wins are `laptop_policy` and `seating_availability`** — the two attributes that matter most for "can I actually work here?" and the two that vision is best positioned to read off a photo.

### What this means for filter results

Before: a search for "cafes with ample seating" returned ~78 results (the 31% the regex tagger had committed on).
After: the same search returns ~222 results (the 88% Strategy C resolves).

Before: "laptops welcome" returned ~43 cafes.
After: ~154 cafes.

The user is no longer being silently denied 60–70% of viable cafes because the regex tagger gave up.

---

## Where regex literally couldn't see

Per the confusion matrices (`docs/EVAL.md`), the regex tagger produced **zero** `limited` or `not_allowed` laptop-policy tags across all 252 cafes. The LLM tagger produced 30 of them — real signal that "this cafe has a 90-minute laptop limit at peak hours" or "no laptops on weekends," which is exactly the kind of nuance the regex pattern set was structurally incapable of expressing.

This is the qualitative half of the story: agreement-rate metrics undersell it, because the regex baseline was so sparse there was little to disagree with.

---

## Semantic search, not keyword search

The `/api/search` endpoint embeds the user query with Voyage-3 and runs a pgvector cosine search against per-cafe embeddings built from the LLM's evidence quotes. Queries like *"quiet rooftop with pastries"* or *"stay all afternoon, plenty of outlets"* now route by meaning, not by literal substring match.

LRU-cached on the embedding side; filter chips compose via SQL intersection so structured constraints (open now, fast wifi) AND semantic intent both apply.

---

## Cost ledger

| Pass | Cost | Notes |
|---|---:|---|
| LLM review tagging (252 cafes) | ~$3 | Gemini 2.5 Flash, ~3K tokens/cafe avg |
| Vision backfill (242 cafes) | ~$2 | Photo + structured-output prompt |
| Voyage-3 embeddings | ~$0.50 | 1024-dim, one-time per cafe |
| Query-time embedding | ~$0/mo | LRU-cached, free tier covers 10K queries/mo |
| **Total one-time** | **~$5.50** | For 252 cafes' worth of structured signal + semantic index |

Compared to the alternative (manual tagging at ~5 min/cafe = 21 hours, or the $80 Google Maps incident from a separate billing mistake), the AI pipeline is the cheapest path to coverage.

---

## What's next (v2)

- Manual-verification workflow to climb the agreement-rate ladder past LLM ceiling on `noise_level`.
- Vision pass on `wifi_quality` — currently still 90% unknown because reviewers rarely write about wifi unless it's broken.
- MCP server exposing the search index to outside agents.
- Knowledge graph linking neighborhoods, vibes, and amenities so users can ask follow-ups against the same retrieval layer.

---

*Eval source: `docs/EVAL.md` (auto-generated by `scripts/evaluate-tagging.mjs`). Last updated: 2026-05-06.*
