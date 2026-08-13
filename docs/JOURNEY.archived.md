# Needle Space — Project Journey

A running reflection on the decisions, pivots, and lessons from building Needle Space. Not a changelog — that's what git is for. This is the thinking *behind* the changes: why I chose what I chose, what I'd undo with hindsight, and what patterns about how I work are starting to repeat.

Last updated: 2026-05-18

> **How to add to this doc:** Type `/reflection` in Claude Code. It will prompt you for the moment you want to capture and append it to the "Reflections (rolling log)" section at the bottom.

***

## The phases so far

### Phase 1 — MVP scaffold (Initial commit → first deploy)

Got a Next.js + Supabase app on the air. Cafe data pulled from Google Places, stored in Supabase, rendered server-side. Simple list and map views, binary filter chips, mobile-first.

**What I was optimizing for:** ship something real and visible fast.

### Phase 2 — Hosting / deploy fight (commits `95c6b2b`, `64eb248`, `26f9f5e`, `147c03a`)

Four commits in a row are deploy-debugging on Netlify:

* `Fix Netlify deploy error by setting a different publish directory`

* `Merge pull request #1` (the agent fix above)

* `Force dynamic rendering so pages fetch from Supabase at runtime`

* `Add debug logging to getCafes for Netlify troubleshooting`

Eventually the project moved to Vercel (per `CLAUDE.md`). Net: a chunk of time spent on platform plumbing rather than the product.

### Phase 3 — The $80 incident (documented in `docs/LESSONS.md`)

Google Maps + Places + Photos billed **$80** before I noticed. Root causes were stacked:

1. No daily quota cap on the API keys.

2. Google Places photo URLs (with the API key in the query string) were stored in `cafes.photo_url` and rendered directly in the browser — every page load hit Google, every key was scrape-able.

3. No caching layer — per-render API calls instead of one-and-done.

Fixes: per-API daily quota caps, billing alerts at 50/80/100% of the monthly credit, `scripts/cache-photos.mjs` that downloads each photo once and re-hosts on Supabase CDN.

The deeper insight in `LESSONS.md`: *the cost of a single API call doesn't intuitively scale with how visible the call is.* A photo card "just looks like an image" whether it's free CDN or a billed API call — and that gap between *how it looks* and *how it bills* is where money leaks.

### Phase 4 — AI v1 sprint (`c657ea9` "Ship AI v1: LLM tagger + vision backfill + semantic search")

The portfolio-anchor move. Replaced the regex tagger (~300 keywords across 5 attributes) with an LLM pipeline that produces structured tags + confidence + evidence quotes, plus a 1024-dim embedding per cafe for natural-language search.

Key choices in `docs/AI-PLAN-v1.md`:

* **Two-tier architecture:** offline LLM pipeline (monthly, expensive); online query path (pgvector + cached query embeddings, <50ms, ~$0.0000002 per query). No LLM in the hot path.

* **Preserve regex tags as eval baseline.** The portfolio story is "I replaced 300 hardcoded keywords with an *evaluated* LLM pipeline" — not just "I added an LLM."

* **LangGraph.js for orchestration** even though a plain script would have worked, because the graph topology (extract → validate → retry → embed) is what makes this a portfolio piece.

* **Voyage-3-lite embeddings** for the Anthropic-aligned narrative.

* **Defer everything else:** no MCP, no chat UI, no LLM re-ranking, no auth, no knowledge graph. (MCP is on the v2 roadmap.)

Mid-sprint pivot worth a note: the pipeline LLM ended up as **Gemini 2.5 Flash**, not Claude Haiku 4.5 as the plan specified. Reasoning is captured in [D7](#d7--pipeline-llm-swap-haiku-45--gemini-25-flash).

### Phase 5 — Design polish (Apr–May, ~12 commits ending at `2bc6bfa`)

A long tail of design iteration after the AI work was in: editorial postcard cards (Direction C), slimmer filter chips, treasure-card hydration fixes, smart back-link, scroll-to-top, productivity-score backfill, pre-ship audit. The work felt small per commit but added up.

Weight check: roughly 12+ commits on visible design polish vs ~5 commits on the AI v1 work itself. That ratio is worth being honest about — see "How I work" below.

***

## Decision log

### D1 — Skip auth for MVP

**Choice:** Read-only public app, no signup, no accounts.\
**Alternative:** Add Supabase Auth from day 1 to support future user reviews.\
**Why:** Slashed scope by an enormous amount. Reviews / personalization weren't going to ship in v1 anyway, so auth would have been infrastructure for a feature that didn't exist yet.\
**Hindsight:** Right call. Saved weeks.

### D2 — Monthly batch pull from Google Places (not live API on user requests)

**Choice:** Cron-style script pulls cafes once a month, stores in Supabase. The app only talks to Supabase.\
**Alternative:** Hit Google Places on the user request path.\
**Why:** Predictable cost, no surprise bills, instant page loads.\
**Hindsight:** Right call — and it's what eventually made the $80 incident (Phase 3) recoverable rather than catastrophic. The damage was confined to the photo render path.

### D3 — Regex tagger first, LLM tagger second

**Choice:** Shipped a `scripts/analyze-reviews.mjs` regex pipeline first, then layered the LLM pipeline on top with `*_llm` columns alongside the regex columns.\
**Alternative:** Skip regex, go straight to LLM.\
**Why:** Two reasons. (1) Regex was cheap to ship and got the product live. (2) Keeping the regex output as ground truth gave me an eval baseline — agreement rate, Cohen's kappa, confusion matrices. That eval is the actual portfolio artifact, not the LLM itself.\
**Hindsight:** Strong PM move. The eval *is* the story.

### D4 — Multi-value filter chips, not binary toggles

**Choice:** WiFi chip is now `fast / moderate-or-better / any` rather than on/off.\
**Why:** Captures actual user preference. "I want fast" and "I want at least moderate" are different needs; an on/off chip can't tell them apart.\
**Hindsight:** Right shape, even if it added pipeline complexity (chips have to compose with the NL search via SQL intersection).

### D5 — Netlify → Vercel

**Choice:** Moved hosting partway through.\
**Cost:** Several commits of deploy fighting before the move.\
**Why I picked Netlify first:** No specific reason — I thought it would be the easiest way to get something live. It wasn't a researched choice; it was the path of least resistance from where I was sitting.\
**Hindsight:** The stack is Next.js + Supabase, so Vercel was the native target the whole time. "Easiest way" turned out to be a local minimum — easy to start, costly to debug, costly to migrate. Next time the framework picks the host: Next.js → Vercel, full stop. The five minutes I'd have spent reading "which host does Next.js recommend" would have saved a phase of deploy-fighting.

### D6 — Defer the manual-verification workflow (memory: only 1 of 252 cafes is `verified=true`)

**Choice:** Per the original plan, the top 80–100 cafes were supposed to be manually verified with work-specific data. Only 1 actually is, as of 2026-04-30.\
**What happened:** No tool was ever built to make verification fast (admin view, keyboard flow, batch edit). So verification became a chore and got skipped.\
**Eval impact:** The portfolio story had to shift from "verified vs LLM" to "regex vs LLM across all 252." Still a story — but a different one than the plan implied.\
**Hindsight:** When a manual workflow is on the critical path, the ergonomics of *doing the manual work* deserve as much design as the AI pipeline that surrounds it. A 30-minute admin page would have unblocked the whole verified-cafe arc.

### D7 — Pipeline LLM swap (Haiku 4.5 → Gemini 2.5 Flash)

**What changed:** Planning doc specified Haiku 4.5. Shipped version uses Gemini 2.5 Flash with a vision backfill pass.\
**Why:** To save on billing. I already had Gemini API keys with credits available, so swapping let me run the full 252-cafe pipeline without spinning up a new paid line item. Post-$80-incident, "use the keys you already have" was a hard constraint.\
**Hindsight:** Right call for this stage. The portfolio story is the *pipeline shape* — LangGraph topology, structured outputs, confidence + evidence quotes, eval against the regex baseline — not which vendor's model sits inside one node. The swap is also a useful talking point: it shows the choice was driven by real cost discipline, not model-loyalty. If a reviewer pushes on "why not Anthropic for an Anthropic-aligned story?", the answer is simply: budget came first, and the architecture is portable to Haiku in one config change if/when the budget allows.

### D8 — Productivity score backfill (`e347c50`)

**Choice:** Recomputed scores from a merged LLM+regex signal (`docs/SCORE-UPDATE.md`); 218 of 252 cafes updated, swings of ±1.3.\
**Why this is interesting:** The score model itself evolved mid-project. The headline scores users saw on day one were not the same scores they'd see now. That's normal for a curated app but worth tracking — the user-facing primitive (a "productivity score") was iterated on as a real product surface, not a fixed number.

***

## What I'd do differently next time

### 1. Set the cost guardrails *before* the first paid-API call

The $80 incident was preventable. Daily quota caps + billing alerts cost zero to set up and take 5 minutes. The reason they weren't set up is that everything *seemed* fine until the bill arrived — and "seems fine" is exactly when paid APIs leak.

**Rule for next project:** before any key is checked in, the corresponding daily quota cap exists. Before the first deploy, the billing alert is wired. No exceptions, even for "just testing."

### 2. Never let an API key touch a URL that ships to a browser

The photo-URL-with-key-embedded bug is the same shape as a SQL injection bug — a value that should be server-side leaked into a client-side surface. Cache stable artifacts server-side as a default, not as a remediation.

### 3. Design the manual workflow with the same care as the AI pipeline

The verified-cafe gap (D6) is a workflow-ergonomics failure, not a motivation failure. If verifying a cafe takes 4 minutes per cafe, verifying 80 cafes takes 5+ hours — which becomes "next weekend" forever. A 30-minute investment in a keyboard-driven admin page would have unblocked the whole arc.

**Rule for next project:** if a feature depends on me doing manual work, the manual work tool is a deliverable, not a side quest.

### 4. Pick the framework-native host on day 1

Next.js → Vercel. SvelteKit → Cloudflare/Vercel. Astro → Netlify/Vercel. The deploy plumbing is a tax on the project — pay it once on the right platform, not twice across two.

### 5. Probe the dev server before sharing a URL

Already in memory. Port 3000 sometimes has a stale process; `npm run dev` silently falls back to 3001; `NEXT_PUBLIC_*` vars are inlined when the server *starts*, so editing `.env.local` after the fact has no effect. Today's `InvalidKeyMapError` was exactly this pattern — two stale Next servers serving the wrong key.

**Rule for next project:** `curl` the port before trusting the dev-server log. If `.env.local` changed, restart.

### 6. Write the "why I picked this model" down at decision time

The Haiku → Gemini swap (D7) is the most-asked question a portfolio reviewer will have, and right now the answer is in my head and fading. Decisions about models, vendors, and architectures need a one-paragraph "why" the day they're made — not the week the writeup is due.

***

## How I work — patterns I'm starting to notice

These are honest observations, not self-critique. They're useful to know about myself.

* **I over-index on visible polish.** Phase 5 has ~12 commits of design iteration after the AI v1 ship; the AI v1 itself is ~5 commits. Polish is satisfying and shippable; the next AI capability is murkier. If the goal is "top AI-fluency portfolio piece" (per my own memory note), the ratio should sometimes flip.

* **I learn from money before I learn from plans.** The $80 incident produced more durable discipline than any pre-flight checklist did. That's expensive tuition — worth noticing the pattern so I can install the discipline *before* the next bill.

* **I plan thoroughly, then change my mind mid-build, and don't always update the plan.** `AI-PLAN-v1.md` says Haiku; the code ships Gemini. Both are fine; the gap is what the *plan doc* should have caught. Plans that don't get updated stop being plans.

* **I'm strongest when the product story drives the technical choice.** D3 (regex first, LLM second, eval as the artifact) is the kind of move that came from PM thinking, not engineer thinking. Lean into that — it's the actual edge.

***

## Reflections (rolling log)

⠀