/**
 * Read-only Google Places operational-status audit.
 *
 * Usage:
 *   node scripts/audit-business-status.mjs
 *   node scripts/audit-business-status.mjs --delay-ms 500
 *   node scripts/audit-business-status.mjs --limit 25
 *
 * The script makes one Place Details (New) request per cafe and prints only
 * non-operational places. It does not write Google data back to Supabase.
 */

import { createClient } from "@supabase/supabase-js";
import { env } from "./_env.mjs";

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const GOOGLE_KEY = env.GOOGLE_PLACES_SERVER_KEY || env.GOOGLE_PLACES_API_KEY;
const argv = process.argv.slice(2);

function readNumberFlag(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

const LIMIT = readNumberFlag("--limit", 0);
const DELAY_MS = readNumberFlag("--delay-ms", 500);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getStatus(googlePlaceId) {
  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(googlePlaceId)}`, {
    headers: {
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": "businessStatus,movedPlaceId",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function main() {
  if (!GOOGLE_KEY) throw new Error("Missing Google Places API key");

  const { data, error } = await supabase
    .from("cafes")
    .select("id,name,address,google_place_id")
    .order("name");
  if (error) throw new Error(`Unable to load cafes: ${error.message}`);

  const cafes = LIMIT ? data.slice(0, LIMIT) : data;
  const closed = [];
  const failures = [];
  let operational = 0;

  console.log(`Auditing ${cafes.length} cafe(s) at ${DELAY_MS}ms intervals...`);
  for (const [index, cafe] of cafes.entries()) {
    if (index > 0 && DELAY_MS) await sleep(DELAY_MS);
    try {
      const place = await getStatus(cafe.google_place_id);
      const status = place.businessStatus || "BUSINESS_STATUS_UNSPECIFIED";
      if (status === "CLOSED_TEMPORARILY" || status === "CLOSED_PERMANENTLY") {
        closed.push({
          name: cafe.name,
          address: cafe.address,
          google_place_id: cafe.google_place_id,
          business_status: status,
          moved_place_id: place.movedPlaceId || null,
        });
      } else {
        operational++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ name: cafe.name, google_place_id: cafe.google_place_id, error: message });
      if (message === "HTTP 429") {
        console.log("Google rate limit reached; stopping without retrying.");
        break;
      }
    }

    if ((index + 1) % 25 === 0 || index + 1 === cafes.length) {
      console.log(`  Checked ${index + 1}/${cafes.length} · closed ${closed.length} · failures ${failures.length}`);
    }
  }

  console.log("\nClosed cafes:");
  if (closed.length === 0) console.log("  None found.");
  for (const cafe of closed) {
    console.log(`  ${cafe.business_status} · ${cafe.name} · ${cafe.address}`);
  }
  console.log(`\nSummary: ${operational} operational/other · ${closed.length} closed · ${failures.length} failed`);
  console.log(`STATUS_AUDIT_JSON=${JSON.stringify({ checked_at: new Date().toISOString(), closed, failures })}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
