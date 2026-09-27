# Scripts Overview

This directory contains three scripts for building and maintaining Needle Space's cafe database.

---

## Script Summary

| Script | Purpose | Writes to DB? |
|---|---|---|
| `fetch-cafes.mjs` | Pulls cafe listings from Google Places API | Yes |
| `analyze-reviews.mjs` | Tags each cafe with workspace attributes | Yes (unless `--dry-run`) |
| `discover-keywords.mjs` | Surfaces new phrases to improve the tagger | Never — read-only |
| `evaluate-retrieval.mjs` | Scores NL search quality against `golden-queries.json` (Recall@k, MRR) | Never — read-only |

---

## How `analyze-reviews.mjs` and `discover-keywords.mjs` Work Together

They serve completely different purposes in the workflow:

| | `analyze-reviews.mjs` | `discover-keywords.mjs` |
|---|---|---|
| **What it does** | Tags each cafe with workspace attributes | Finds new phrases to add to the tagger |
| **Input** | Your SIGNALS keyword list | All review text from all cafes |
| **Output** | Writes `wifi_quality`, `noise_level` etc. to Supabase | Prints phrases to your terminal |
| **When to run** | Monthly batch + anytime you update SIGNALS | During SIGNALS tuning sessions only |

### The Workflow Loop

```
discover-keywords.mjs            analyze-reviews.mjs
       │                                │
       │  --find "outlet" --suggest     │
       │  → surfaces "many outlets"     │
       │    "outlets and wifi" (new!)   │
       │                                │
       ▼                                │
  You add these to SIGNALS  ──────────► │  --dry-run --cafe "Caffe Vita"
                                        │  → now catches "many outlets" ✓
                                        │
                                        ▼
                              node analyze-reviews.mjs
                              → writes to Supabase
```

Think of `discover-keywords.mjs` as your **research tool** and `analyze-reviews.mjs` as your **production tool**. Use the first to improve the second.

---

## Monthly Batch Workflow

Run these in order each month:

```bash
# 1. Pull fresh cafe data from Google Places API
node scripts/fetch-cafes.mjs

# 2. (Optional) Tune keywords first
node scripts/discover-keywords.mjs --find "wifi" --suggest

# 3. Dry-run the tagger to spot-check results
node scripts/analyze-reviews.mjs --dry-run --cafe "Caffe Vita"

# 4. Run the tagger for real
node scripts/analyze-reviews.mjs
```

---

## Reading `discover-keywords.mjs` Output

When surfacing new keyword candidates, look for:

| Pattern | What it means | Where to add it in SIGNALS |
|---|---|---|
| `"no wifi"` / `"don't have wifi"` | Cafe intentionally has no WiFi | `wifi.none` |
| `"wifi spotty"` / `"not very stable"` | Unreliable connection | `wifi.slow` or `wifi.moderate` |
| `"many outlets"` / `"outlets everywhere"` | Good power availability | `outlets.good` |
| `"packed"` / `"always crowded"` | Hard to find a seat | `seating.limited` |
| `"no laptop"` / `"laptop-free"` | Explicit laptop policy | `laptop_policy.not_allowed` |

Any phrase appearing **2+ times** across cafes is worth considering for SIGNALS.

## Evaluation and labels

- **Label cafes** at `/admin` (needs `ADMIN_PASSWORD` outside `npm run dev`). Labels go to `cafes.human_labels`, win over the model on the site, and are the answer key for the evals. The model's answer stays hidden until you pick yours.
- `node scripts/evaluate-accuracy.mjs [--matrices]` — accuracy and coverage of the model, the keyword tagger, and what shipped, against your labels. Quote nothing below 20 labels per attribute.
- `node scripts/evaluate-retrieval.mjs [--via-api]` — Hit@k, Recall@k, nDCG@k and MRR on `golden-queries.json`. `--via-api` measures the real `/api/search` path. Prefer `expected_ids` for new labels.
- `node scripts/quality-metrics.mjs --baseline docs/quality-baseline.json --since-last-pass --record` — the pipeline's gate. Measures every cafe changed since the last passing gate, adds accuracy once 20+ cafes are labeled, and records the outcome in `pipeline_gate_runs`.
- `.github/workflows/nightly-eval.yml` runs the first two every night and posts the numbers to the run summary.
