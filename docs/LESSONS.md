# Lessons learned — Needle Space build log

A personal log of things that went wrong, cost money, or surprised me while\
shipping Needle Space. Kept for portfolio writeups, retros, and future\
projects that touch paid APIs.

***

## 1. Always set quota caps before hitting a paid API in production

**What happened:** The Google Maps Platform monthly bill hit **$80** before\
I caught it. Maps + Places + Photos APIs were silently being called every\
time someone (including me, debugging) loaded the app, and I hadn't\
configured a daily quota cap on the keys.

**Why it cost real money:** Google's $200 monthly free credit covers the\
*budget* but not the *velocity* — a runaway loop or careless render can burn\
through the credit in a day, and overages bill immediately. There's no "ask\
me first" prompt on overages by default.

**What I did:**

* Set per-API daily quota limits in Google Cloud Console for Maps, Places, and Photos individually.

* Set up a billing alert at 50% / 80% / 100% of the monthly credit.

* Audited every place the keys are used and made sure each call is intentional (not in a render loop).

**General principle:** Before *any* paid API ships to a public surface, set\
a daily quota cap *and* a billing alert. The cap is the hard stop. The\
alert is the early warning. Don't rely on the monthly free credit alone —\
it's a budget, not a brake.

***

## 2. Never embed API keys in public URLs

**What happened:** The first version of the photo pipeline stored the\
Google Places photo URL directly in `cafes.photo_url`, which looked like:

```text
https://places.googleapis.com/v1/places/.../photos/.../media?key=AIzaSy...&maxHeightPx=400
```

Every browser that rendered a cafe card had that URL in its DOM and made a\
request directly to Google with the API key in the query string. The key\
was visible in the page source, in the network tab, and (worse) cached by\
intermediaries. Anyone could scrape the key and use it from their own\
domain.

**Why it's a real problem:**

* The key shows up in any user's browser DevTools / page source.

* Caches and proxies can record the URL with the key embedded.

* A compromised key leads straight to billing fraud — someone uses your Google account to serve their own product.

**What I did:**

* Built `scripts/cache-photos.mjs` to download each photo *once* using the service-side key and re-upload it to Supabase Storage as a public asset.

* Rewrote `cafes.photo_url` to point at the Supabase CDN URL — no key, no Google call on render.

* Restricted the Google API key in Cloud Console to specific HTTP referrers and API scopes (defense in depth, but the cache fix is the real one).

**General principle:** API keys never belong in URLs that ship to a browser.\
If a third-party asset needs to be displayed publicly, fetch it server-side\
once and host it yourself. The cost of the one-time download + storage is\
almost always less than per-render API calls anyway.

***

## 3. Cache third-party assets — don't pay per render

**What happened:** Without caching, every page load that showed N cafes\
made N Google Places Photo API calls. At ~$7 per 1,000 photo requests\
(Places Photo API pricing), 1,000 page loads of a 6-cafe list = 6,000\
photo calls = ~**$42 just for thumbnails**. Multiply by a real traffic\
pattern and you can see how the $80 bill happened.

**Why this is the most common shape of accidental cloud spend:**

* Pricing is per *request*, not per *unique image*.

* Browsers don't deduplicate requests across users — every visitor pays.

* Photos look identical to a developer ("just an image"), so the cost surface isn't visible until the bill arrives.

**What I did:**

* Same `scripts/cache-photos.mjs` script: download each Google photo once, upload to Supabase Storage (free under 1 GB at the time).

* All future renders of those photos are served from Supabase's CDN at zero per-request cost.

* The script is idempotent (skips already-cached photos), so re-runs are safe and the monthly cafe refresh job only pays for new cafes.

**General principle:** Anywhere a paid API returns a stable artifact (a\
photo, a doc, an embedding, an LLM completion you can deterministically\
reproduce), pay for it *once* and store the result. Treat external API\
calls like premium ingredients — measure twice, fetch once.

***

## Meta-takeaway

Three different bugs, one shared root cause: **the cost of a single API**\
**call doesn't intuitively scale with how visible that call is.** A photo\
URL on a card looks identical whether it's a free CDN reference or a $0.007\
Google call — and that asymmetry between *how it looks* and *how it bills*\
is where money leaks. The discipline I'd carry to any future project that\
touches a paid API:

1. Set a daily cap *before* the first real call.

2. Audit every place a key could end up in a public response (URLs, error messages, logs).

3. Cache anything that's stable, even if it feels premature.

⠀