# Needle Space — Product Requirements Document

**Work-Friendly Cafe Discovery for Seattle Metro**
Version 1.0 · Last updated 2026-04-06

---

## Executive Summary

Needle Space is a mobile-first web app that helps remote workers, freelancers, and students find cafes they can actually work from. Unlike Google Maps or Yelp, Needle Space is purpose-built around work-specific criteria: WiFi quality, power outlets, noise level, seating comfort, and laptop policy.

The promise: **find your spot in under two minutes**, every time.

## The Problem

Remote workers lose time and energy daily hunting for a productive cafe. They check Maps, scan Yelp reviews, walk in, get burned by spotty WiFi or a "no laptops after 11am" sign, and start over. Generic discovery apps don't capture what actually matters when you're trying to get work done.

## The Solution

A curated, Seattle-focused database of cafes scored on real workspace conditions. Filter by what matters (WiFi, outlets, noise, laptop policy), see cafes on a map or list, and tap through to a detail page that tells you exactly what to expect before you go.

**What makes Needle Space 10x better:**
- Work-specific data, not generic restaurant tags
- Curated for Seattle by people who actually work from cafes here
- Zero friction — no login, no signup, no app store

---

## Goals & Success Metrics

### Business Goals (6 months post-launch)
- **Acquisition:** 1,500 unique monthly visitors
- **Engagement:** 2+ searches per returning user per week
- **Retention:** 50% of users return within 7 days; 35% MAU retention at month 3
- **Satisfaction:** NPS +50, 4.5★ average sentiment from beta testers

### User Goals
- Find a work-friendly cafe in **under 2 minutes** (vs. ~20 min today)
- Avoid bad experiences: slow WiFi, no outlets, crowded, hostile to laptops
- Discover new spots that match personal work style
- Build a rotation of 5–10 reliable cafes

### Technical Targets
- 99% uptime
- Search/filter results render in <2s for 95% of interactions
- Mobile Lighthouse score 90+

---

## Target Users

### Geographic Scope
**Launch market:** Seattle Metro
- **Primary:** Seattle city core (Downtown, Capitol Hill, Fremont, Ballard, U-District)
- **Secondary:** Eastside (Bellevue, Redmond, Kirkland)
- ~800 cafes in the addressable region

### Personas

**1. The Freelance Maker (Primary)**
Age 28–45, designer/developer/writer, works from cafes 2–5x per week, stays 2–4 hours per session. Cares deeply about WiFi reliability, outlet access, and a noise level they can tolerate. Willing to walk 10 extra minutes for the right spot.

**2. The Hybrid Worker**
Age 30–50, tech/creative employee, works from a cafe 1–2x per week to break up the home office. Values comfort and consistency — wants a known-good rotation, not surprises.

**3. The Grad Student**
Age 22–32, studies for hours at a stretch, prefers quiet over buzzy, sensitive to laptop policies and minimum-purchase norms. Highly price-conscious.

### What All Three Share
They've all been burned by a cafe that looked great on Google but turned out to be unworkable. They want **trustworthy, work-specific signal** before they commit.

---

## Scope

### In Scope (MVP — 2 weeks)
1. **Browse cafes** in map view and list view
2. **Filter chips:** WiFi quality, outlets, noise level, laptop policy, open now
3. **Cafe detail pages** with workspace info, photos, hours, Google Maps directions
4. **Mobile-responsive design** (375px minimum width)
5. **Pre-loaded database** of ~300–400 Seattle-area cafes from Google Places API
6. **Top 80–100 manually verified** with work-specific attributes (WiFi, outlets, noise, laptop policy)
7. **Auto-tagging** of remaining cafes via review keyword scanning

### Explicitly Out of Scope (Phase 2+)
- User accounts, authentication, profiles
- User-submitted reviews, check-ins, ratings
- Personalized recommendations or "Quick Match" engine
- Cafe owner dashboard / claim flow
- Notifications, gamification, social features
- LLM-powered search (filter chips do the job for MVP)
- Any AI features
- Multi-city expansion
- Food ordering, delivery, loyalty programs

---

## Functional Requirements

### 1. Home / Discovery (Priority: HIGH)
- Landing screen with search/location entry, filter chips, and toggle between **List** and **Map** view
- Default to user's current location if granted, otherwise default to Seattle downtown
- Filter chips are sticky and persist as user scrolls

### 2. Filtering (Priority: HIGH)
Core work-specific filters:
- **WiFi Quality:** Fast / Decent / Spotty
- **Outlets:** Plenty / Some / Limited / None
- **Noise Level:** Quiet / Low hum / Buzzy / Loud
- **Laptop Policy:** Welcomed / Tolerated / Time-limited / Not allowed
- **Open Now** (toggle)

Filters combine with AND logic. URL reflects active filters so results are shareable.

### 3. List View (Priority: HIGH)
- Card-based layout
- Each card shows: name, neighborhood, distance, hero image, productivity badges (WiFi/outlets/noise/policy at a glance), open/closed status
- Tap card → cafe detail page

### 4. Map View (Priority: HIGH)
- Google Maps JS API
- Custom pins indicating productivity tier
- Tap pin → mini card preview
- Tap preview → cafe detail page
- Filters apply to both views simultaneously

### 5. Cafe Detail Page (Priority: HIGH)
- Hero image and gallery
- Productivity Score (aggregate 1–5 based on our verified attributes)
- Work-specific section: WiFi, outlets, noise profile, laptop policy, seating comfort
- Basic info: address, hours (with open/closed indicator), phone, website
- "Get Directions" CTA → opens Google Maps
- "Share" CTA → native share sheet

### 6. Data Pipeline (Backend, not user-facing)
- Monthly batch pull from Google Places API → store in Supabase
- Review keyword scanner auto-tags work attributes for unverified cafes
- Manual verification queue for editors to confirm top 80–100 cafes
- Google Place IDs are the foreign key

---

## User Experience

### Entry Points
- Direct link / search engine
- Word-of-mouth
- Cafe partnership QR codes (post-launch)

### First-Time Flow
1. User lands on home screen — no signup, no modal, no friction
2. Browser prompts for location (optional; falls back to Seattle downtown)
3. User sees a list/map of nearby cafes with productivity badges visible
4. User taps filters or a cafe card

### Core Loop
1. **Land** → see nearby cafes immediately
2. **Filter** → narrow by what matters today (e.g., "quiet + outlets")
3. **Scan** → compare productivity badges across cards
4. **Tap** → read the detail page
5. **Go** → tap "Directions" to leave for the cafe

Target: **under 2 minutes** from landing to picking a destination.

### Edge Cases
- **Location denied:** show Seattle-wide default with "Set your location" affordance
- **No results from filters:** show a friendly empty state with a "Clear filters" CTA and a few high-confidence recommendations
- **Offline / API error:** cached cafe data still renders; banner explains the issue

---

## Design Direction

Needle Space's visual identity should feel like the **good kind of cafe**: warm, intentional, lived-in, a little bit handcrafted. Not corporate. Not generic startup. Not another purple-gradient SaaS.

Detailed direction lives in `.claude/skills/needle-space-design/SKILL.md`. The short version:

- **Tone:** editorial, tactile, slightly retro — think specialty coffee zine meets transit map
- **Color:** dominant warm neutrals (cream, espresso, kraft paper) with one sharp accent (e.g. sodium-lamp orange or matcha green)
- **Typography:** distinctive serif or grotesk display paired with a refined humanist sans body — never Inter, never system-default
- **Motion:** purposeful, not decorative — staggered reveals on first paint, satisfying state changes on filter chips
- **Layout:** asymmetric, content-forward, generous negative space; the map and the list feel like two halves of the same printed page

The UI should feel mobile-native but reward a desktop visit with editorial scale.

---

## Technical Architecture

### Stack
| Layer | Choice |
|---|---|
| Framework | Next.js (App Router) |
| Database | Supabase (Postgres) |
| Maps | Google Maps JavaScript API |
| Cafe data source | Google Places API (monthly batch) |
| Styling | Tailwind CSS |
| Hosting | Vercel (free tier) |
| Auth | None for MVP |

### Cost Target
$0/month using free tiers + Google Cloud's $200 monthly credit.

### Data Strategy
- Pull cafe data from Google Places API in monthly batch jobs only
- Store everything in Supabase — **never call Google APIs from the user request path** (cost + latency)
- Work-specific attributes are Needle Space's value-add and live in our own tables, joined to Google Place IDs

### Privacy
- No user accounts → no PII collected in MVP
- Location is requested in-browser, used client-side only, never stored

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| **Data freshness** — cafe info goes stale (hours, WiFi, policy) | Users hit a closed door, lose trust | Monthly Google Places sync; manual verification of top 80–100; clear "last updated" timestamp on detail pages |
| **Cold start** — empty/sparse data on launch | Product feels thin | Seed with 300–400 cafes from Google Places, auto-tag rest, manually verify top 80–100 before launch |
| **RTO trend** — fewer remote workers | Smaller TAM | Position for hybrid workers, freelancers, and students — all of whom still cafe-work weekly |
| **Google Maps adds work filters** | Direct competition | Defensible moat = curation quality, Seattle-specific knowledge, niche focus, community |
| **API quota / cost overruns** | Service interruption | All Google calls are batched server-side; never user-triggered |

---

## MVP Launch Criteria

- 300+ cafes in database from Google Places import
- 80+ cafes manually verified with work-specific attributes
- All filters functional and combinable
- Map and list views render in <2s on mobile
- Lighthouse mobile score 90+
- Zero JavaScript errors on top 10 user paths
- Cafe detail page exists for every cafe in the database

---

## Tracking Plan (Post-MVP)

App opens, filter usage by chip, search-to-detail conversion, detail page → directions tap rate, time-on-detail, repeat visit rate. No PII; aggregate only.

---

## Team & Timeline

- **Jiyae** — Solo PM, all product decisions
- **Claude Code** — All implementation

Two-week MVP build, lean scope, no premature abstractions.
