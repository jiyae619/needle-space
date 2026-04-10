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
- Filter chips: WiFi quality, outlets, noise level, laptop policy, open now
- Cafe detail pages with workspace info + Google Maps directions
- Mobile-responsive design
- Pre-loaded cafe database (~300-400 cafes from Google Places API)
- Top 80-100 manually verified with work-specific data

### Out of Scope (Phase 2+)
- User accounts / authentication
- User reviews, check-ins, ratings
- Personalized recommendations
- Cafe owner dashboard
- Notifications / gamification
- LLM-powered search (use filter chips instead)
- AI features of any kind in MVP

## Data Strategy
- Pull cafe data from Google Places API in monthly batch jobs
- Store everything in Supabase — never call Google API on user requests
- Work-specific attributes (wifi, outlets, noise, laptop policy) are our value-add
- Auto-tag cafes using review keyword scanning, manually verify top picks
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
