/**
 * Needle Space — regex vs LLM tagging eval
 *
 * Compares the existing regex tags (kept as ground truth) against the LLM
 * tags written by scripts/analyze-reviews-llm.mjs. Per-attribute computes:
 *   - n (cafes with both tags non-null)
 *   - agreement rate (% of cafes where regex == llm)
 *   - Cohen's kappa (chance-corrected agreement)
 *   - "unknown" rate on each side (how often each tagger gives up)
 *
 * Cohen's kappa interpretation (Landis & Koch, 1977):
 *   < 0.00  poor          0.21–0.40 fair         0.61–0.80 substantial
 *   0.00–0.20 slight      0.41–0.60 moderate     0.81–1.00 almost perfect
 *
 * Usage:
 *   node scripts/evaluate-tagging.mjs                  ← all cafes, summary table
 *   node scripts/evaluate-tagging.mjs --verified       ← verified=true only
 *   node scripts/evaluate-tagging.mjs --matrices       ← also print confusion matrices
 *   node scripts/evaluate-tagging.mjs --json           ← machine-readable output
 */

import { createClient } from "@supabase/supabase-js";
import { env } from "./_env.mjs";

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const VERIFIED_ONLY = argv.includes("--verified");
const SHOW_MATRICES = argv.includes("--matrices");
const JSON_OUTPUT   = argv.includes("--json");

// ---------------------------------------------------------------------------
// Schema — must mirror the enum in scripts/analyze-reviews-llm.mjs (TagsSchema)
// ---------------------------------------------------------------------------
const ATTRIBUTES = [
  { key: "wifi_quality",         values: ["fast", "moderate", "slow", "none", "unknown"] },
  { key: "outlet_availability",  values: ["every_table", "most", "limited", "none", "unknown"] },
  { key: "noise_level",          values: ["quiet", "moderate", "loud", "unknown"] },
  { key: "laptop_policy",        values: ["welcome", "limited", "not_allowed", "unknown"] },
  { key: "seating_availability", values: ["ample", "adequate", "limited", "none", "unknown"] },
];

// ---------------------------------------------------------------------------
// Stats — Cohen's kappa, agreement, confusion matrix
// ---------------------------------------------------------------------------
function agreementRate(a, b) {
  if (a.length === 0) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) matches++;
  return matches / a.length;
}

// Cohen's kappa = (p_observed - p_expected) / (1 - p_expected)
// where p_expected is the probability of chance agreement given each rater's
// marginal class distribution.
function cohensKappa(a, b, classes) {
  const n = a.length;
  if (n === 0) return 0;
  const observed = agreementRate(a, b);
  let expected = 0;
  for (const c of classes) {
    const pa = a.filter(x => x === c).length / n;
    const pb = b.filter(x => x === c).length / n;
    expected += pa * pb;
  }
  if (expected >= 1) return 1; // both raters always agree on one class
  return (observed - expected) / (1 - expected);
}

function confusionMatrix(predictions, truths, classes) {
  const m = {};
  for (const t of classes) {
    m[t] = {};
    for (const p of classes) m[t][p] = 0;
  }
  for (let i = 0; i < truths.length; i++) {
    const t = truths[i], p = predictions[i];
    if (m[t] && m[t][p] !== undefined) m[t][p]++;
  }
  return m;
}

function kappaInterp(k) {
  if (k < 0)        return "poor";
  if (k <= 0.20)    return "slight";
  if (k <= 0.40)    return "fair";
  if (k <= 0.60)    return "moderate";
  if (k <= 0.80)    return "substantial";
  return "almost perfect";
}

function unknownRate(arr) {
  if (arr.length === 0) return 0;
  return arr.filter(v => v === "unknown").length / arr.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let q = supabase
    .from("cafes")
    .select([
      "id", "name", "verified", "llm_tagged_at",
      ...ATTRIBUTES.flatMap(a => [a.key, `${a.key}_llm`]),
    ].join(", "))
    .not("llm_tagged_at", "is", null);

  if (VERIFIED_ONLY) q = q.eq("verified", true);

  const { data, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }
  if (!data?.length) {
    console.error("No cafes found. Did you run analyze-reviews-llm.mjs first?");
    process.exit(1);
  }

  const scope = VERIFIED_ONLY ? "verified=true" : "all LLM-tagged";
  const results = [];

  for (const attr of ATTRIBUTES) {
    // Skip cafes where either side is null (regex never ran for that attr).
    const pairs = data
      .map(c => ({ regex: c[attr.key], llm: c[`${attr.key}_llm`] }))
      .filter(p => p.regex !== null && p.llm !== null);

    const truths = pairs.map(p => p.regex);
    const preds  = pairs.map(p => p.llm);

    results.push({
      attribute:   attr.key,
      n:           pairs.length,
      agreement:   agreementRate(truths, preds),
      kappa:       cohensKappa(truths, preds, attr.values),
      regex_unk:   unknownRate(truths),
      llm_unk:     unknownRate(preds),
      values:      attr.values,
      truths, preds,
    });
  }

  if (JSON_OUTPUT) {
    // Strip the heavy arrays for machine output.
    console.log(JSON.stringify({
      scope,
      sample_size: data.length,
      results: results.map(r => ({
        attribute: r.attribute,
        n: r.n,
        agreement: r.agreement,
        kappa: r.kappa,
        regex_unknown_rate: r.regex_unk,
        llm_unknown_rate:   r.llm_unk,
      })),
    }, null, 2));
    return;
  }

  // ── Markdown summary table ─────────────────────────────────────────────
  console.log(`# Tagging evaluation — ${scope}\n`);
  console.log(`Sample: **${data.length}** LLM-tagged cafes` +
              (VERIFIED_ONLY ? " (verified subset)" : "") + ".\n");
  console.log(`| Attribute | n | Agreement | Cohen's κ | Interpretation | Regex unk. | LLM unk. |`);
  console.log(`|---|---:|---:|---:|---|---:|---:|`);
  for (const r of results) {
    console.log(
      `| \`${r.attribute}\` | ${r.n} | ${(r.agreement * 100).toFixed(1)}% | ` +
      `${r.kappa.toFixed(3)} | ${kappaInterp(r.kappa)} | ` +
      `${(r.regex_unk * 100).toFixed(0)}% | ${(r.llm_unk * 100).toFixed(0)}% |`
    );
  }
  console.log();
  console.log(`> Regex tags are ground truth (\`scripts/analyze-reviews.mjs\`); LLM tags come from \`scripts/analyze-reviews-llm.mjs\` (Gemini 2.5 Flash + Voyage-3).\n`);

  // ── Optional confusion matrices ────────────────────────────────────────
  if (SHOW_MATRICES) {
    for (const r of results) {
      console.log(`## ${r.attribute}\n`);
      const m = confusionMatrix(r.preds, r.truths, r.values);
      console.log(`| regex ↓ / llm → | ${r.values.map(v => `\`${v}\``).join(" | ")} |`);
      console.log(`|${"---|".repeat(r.values.length + 1)}`);
      for (const t of r.values) {
        const row = r.values.map(p => m[t][p] || 0);
        console.log(`| **\`${t}\`** | ${row.join(" | ")} |`);
      }
      console.log();
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
