# CLAUDE.md — 12-rule template

These rules apply to every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

## Rule 1 — Think Before Coding
State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what's unclear.

## Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

## Rule 3 — Surgical Changes
Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting.
Don't refactor what isn't broken. Match existing style.

## Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified.
Don't follow steps. Define success and iterate.
Strong success criteria let you loop independently.

## Rule 5 — Use the model only for judgment calls
Use me for: classification, drafting, summarization, extraction.
Do NOT use me for: routing, retries, deterministic transforms.
If code can answer, code answers.

## Rule 6 — Token budgets are not advisory
Per-task: 4,000 tokens. Per-session: 30,000 tokens.
If approaching budget, summarize and start fresh.
Surface the breach. Do not silently overrun.

## Rule 7 — Surface conflicts, don't average them
If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

## Rule 8 — Read before you write
Before adding code, read exports, immediate callers, shared utilities.
"Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.

## Rule 9 — Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

## Rule 10 — Checkpoint after every significant step
Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

## Rule 11 — Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Don't fork silently.

## Rule 12 — Fail loud
"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

---

# Needle Space — Laptop-Friendly Cafe Discovery for Seattle

## What This Is
A mobile-first web app that helps remote workers, students, and digital nomads find laptop-friendly cafes in Seattle metro (Seattle, Bellevue, Redmond, Kirkland). Think "Google Maps but only for cafes you can actually work from."

## Who's Building This
- Solo non-technical PM (Jiyae) making all product decisions
- Claude Code writes all the code
- Explain technical concepts in plain, non-jargon language
- When suggesting something, explain WHY briefly so Jiyae can make informed decisions

## Tech Stack
- **Framework:** Next.js (App Router)
- **Database:** Supabase (PostgreSQL)
- **Auth:** None for MVP (read-only public app)
- **Maps:** Google Maps JavaScript API
- **Cafe Data:** Google Places API (monthly batch pull, stored in Supabase)
- **Styling:** Tailwind CSS
- **Hosting:** Vercel (free tier)
- **Cost target:** $0/month using free tiers + Google Cloud $200 monthly credit

## MVP Scope (2 weeks)
### In Scope
- Browse cafes on map + list view
- Filter chips: WiFi quality, outlets, noise level, laptop policy, open now (now multi-value pickers, not on/off toggles)
- Cafe detail pages with workspace info + Google Maps directions
- Mobile-responsive design
- Pre-loaded cafe database (~300-400 cafes from Google Places API)
- Top 80-100 manually verified with work-specific data
- **AI v1 (shipped 2026-04-30, see `docs/AI-PLAN-v1.md`):**
  - Natural-language search bar over a Voyage-3 + pgvector index
  - LangGraph.js pipeline (Gemini 2.5 Flash) re-tags every cafe with confidence + evidence quotes; regex tagger preserved as eval baseline
  - Multi-value filter chips compose with NL search via SQL intersection

### Out of Scope (still — defer to v2+)
- User accounts / authentication
- User reviews, check-ins, ratings
- Personalized recommendations
- Cafe owner dashboard
- Notifications / gamification
- Chat UI / per-result LLM explanations / LLM re-ranking
- MCP server (planned for v2)
- Knowledge graph

## Data Strategy
- Pull cafe data from Google Places API in monthly batch jobs
- Store everything in Supabase — never call Google API on user requests
- Work-specific attributes (wifi, outlets, noise, laptop policy, seating) are our value-add
- Tagging pipeline:
  - Regex tagger (`scripts/analyze-reviews.mjs`) — kept as eval baseline; populates the original `wifi_quality` etc. columns
  - LLM tagger (`scripts/analyze-reviews-llm.mjs`) — populates `*_llm` columns + `tagging_confidence` JSONB + 1024-dim `cafe_embedding`. App reads `*_llm` when present, falls back to regex columns
  - Eval (`scripts/evaluate-tagging.mjs`) — regex vs LLM agreement + Cohen's kappa + confusion matrices
- Manually verify top picks (workflow not yet built — only 1 cafe is `verified=true` as of 2026-04-30)
- Google Place IDs are the foreign key linking our data to Google's

## Code Conventions
- Keep it simple — this is an MVP, not an enterprise app
- Prefer fewer files over many small ones
- No premature abstractions or over-engineering
- Comments only where logic isn't obvious
- All UI must work well on mobile (375px width minimum)

## Key Commands
- `npm run dev` — start local development server
- `npm run build` — build for production
- `npx supabase` — interact with Supabase locally
