/**
 * Signal · extract.ts
 * -------------------
 *
 * Pure regex + keyword extractor for the five v0 facets. Deliberately
 * no LLM / external API — the seed-agency volume is small, we want
 * the extractor to be deterministic across re-runs (the idempotency
 * check relies on identical outputs for identical inputs), and the
 * caller already has a confidence scalar the ranker can thresh.
 *
 * Confidence rubric (shared across facets):
 *
 *   0.90  exact anchored keyword match (e.g. "cardiac anesthesia"
 *         spelled out, or "$180/hr" with an unambiguous rate token).
 *   0.70  anchored dollar amount near a rate word within a 40-char
 *         window, or a state-name match with no explicit preference
 *         verb.
 *   0.50  loose signal — a bare state abbreviation, or an "available"
 *         keyword without a date. Ranker's own threshold
 *         (`signal_weights`) decides whether to use these.
 *
 * Every match carries a `source_span` (char_start / char_end) back
 * into the conversation body so the UI can highlight the evidence
 * when the recruiter asks "where did this come from?".
 */

export const FACETS = [
  "REGION_PREFERENCE",
  "TIMING_WINDOW",
  "RATE_EXPECTATION",
  "SUBSPECIALTY_INTEREST",
  "AVAILABILITY_SIGNAL",
] as const;
export type Facet = (typeof FACETS)[number];

export interface SourceSpan {
  start: number;
  end: number;
}

export interface Extract {
  facet: Facet;
  value: unknown;
  confidence: number;
  sourceSpan: SourceSpan;
}

// ─── Region preference ────────────────────────────────────────────────

/**
 * Maps US state names and abbreviations to the canonical two-letter
 * code we write into `value.state`. Alphabetically ordered; we match
 * on word boundaries so "indiana" never fires inside "indianapolis"
 * and "OR" never fires inside "FORK". We keep this list
 * anesthesia-locum-pilot-centric — all 50 are in because the regex
 * cost is trivial and leaving CA / TX out would skew early tests.
 */
const US_STATES: ReadonlyArray<{ name: string; abbr: string }> = [
  { name: "Alabama", abbr: "AL" },
  { name: "Alaska", abbr: "AK" },
  { name: "Arizona", abbr: "AZ" },
  { name: "Arkansas", abbr: "AR" },
  { name: "California", abbr: "CA" },
  { name: "Colorado", abbr: "CO" },
  { name: "Connecticut", abbr: "CT" },
  { name: "Delaware", abbr: "DE" },
  { name: "Florida", abbr: "FL" },
  { name: "Georgia", abbr: "GA" },
  { name: "Hawaii", abbr: "HI" },
  { name: "Idaho", abbr: "ID" },
  { name: "Illinois", abbr: "IL" },
  { name: "Indiana", abbr: "IN" },
  { name: "Iowa", abbr: "IA" },
  { name: "Kansas", abbr: "KS" },
  { name: "Kentucky", abbr: "KY" },
  { name: "Louisiana", abbr: "LA" },
  { name: "Maine", abbr: "ME" },
  { name: "Maryland", abbr: "MD" },
  { name: "Massachusetts", abbr: "MA" },
  { name: "Michigan", abbr: "MI" },
  { name: "Minnesota", abbr: "MN" },
  { name: "Mississippi", abbr: "MS" },
  { name: "Missouri", abbr: "MO" },
  { name: "Montana", abbr: "MT" },
  { name: "Nebraska", abbr: "NE" },
  { name: "Nevada", abbr: "NV" },
  { name: "New Hampshire", abbr: "NH" },
  { name: "New Jersey", abbr: "NJ" },
  { name: "New Mexico", abbr: "NM" },
  { name: "New York", abbr: "NY" },
  { name: "North Carolina", abbr: "NC" },
  { name: "North Dakota", abbr: "ND" },
  { name: "Ohio", abbr: "OH" },
  { name: "Oklahoma", abbr: "OK" },
  { name: "Oregon", abbr: "OR" },
  { name: "Pennsylvania", abbr: "PA" },
  { name: "Rhode Island", abbr: "RI" },
  { name: "South Carolina", abbr: "SC" },
  { name: "South Dakota", abbr: "SD" },
  { name: "Tennessee", abbr: "TN" },
  { name: "Texas", abbr: "TX" },
  { name: "Utah", abbr: "UT" },
  { name: "Vermont", abbr: "VT" },
  { name: "Virginia", abbr: "VA" },
  { name: "Washington", abbr: "WA" },
  { name: "West Virginia", abbr: "WV" },
  { name: "Wisconsin", abbr: "WI" },
  { name: "Wyoming", abbr: "WY" },
];

/** A verb that implies the counterparty WANTS this region — not just that it exists. */
const REGION_PREFERENCE_VERBS = [
  "prefer",
  "preferring",
  "preference",
  "want",
  "wants",
  "want to work",
  "would like",
  "open to",
  "stick to",
  "stay in",
  "based in",
  "located in",
  "live in",
  "lives in",
  "moving to",
  "relocating to",
  "interested in",
  "focus on",
];

function hasNearbyVerb(body: string, index: number, verbs: readonly string[]): boolean {
  const lower = body.toLowerCase();
  // 60-char window to the left of the match covers "I'd prefer <state>"
  // and "want to work in <state>" without pulling in a sentence over.
  const start = Math.max(0, index - 60);
  const window = lower.slice(start, index);
  return verbs.some((v) => window.includes(v));
}

function extractRegionPreference(body: string): Extract[] {
  const out: Extract[] = [];
  const takenSpans = new Set<number>();
  // Full names first; they score higher and we record their spans so
  // the abbreviation pass doesn't double-emit on "California (CA)".
  for (const { name, abbr } of US_STATES) {
    const re = new RegExp(`\\b${name}\\b`, "gi");
    let m: RegExpExecArray | null = re.exec(body);
    while (m !== null) {
      const confidence = hasNearbyVerb(body, m.index, REGION_PREFERENCE_VERBS) ? 0.9 : 0.7;
      out.push({
        facet: "REGION_PREFERENCE",
        value: { state: abbr, matched: m[0] },
        confidence,
        sourceSpan: { start: m.index, end: m.index + m[0].length },
      });
      for (let i = m.index; i < m.index + m[0].length; i += 1) takenSpans.add(i);
      m = re.exec(body);
    }
  }
  for (const { abbr } of US_STATES) {
    // Abbreviations must be anchored by non-letter on both sides AND
    // match verbatim (case-sensitive) — lower-case "or" / "in" / "me"
    // would otherwise fire constantly inside ordinary prose.
    const re = new RegExp(`(?<![A-Za-z])${abbr}(?![A-Za-z])`, "g");
    let m: RegExpExecArray | null = re.exec(body);
    while (m !== null) {
      if (takenSpans.has(m.index)) {
        m = re.exec(body);
        continue;
      }
      const confidence = hasNearbyVerb(body, m.index, REGION_PREFERENCE_VERBS) ? 0.7 : 0.5;
      out.push({
        facet: "REGION_PREFERENCE",
        value: { state: abbr, matched: m[0] },
        confidence,
        sourceSpan: { start: m.index, end: m.index + m[0].length },
      });
      m = re.exec(body);
    }
  }
  return out;
}

// ─── Timing window ────────────────────────────────────────────────────

const MONTHS: ReadonlyArray<{ name: string; num: number }> = [
  { name: "january", num: 1 },
  { name: "february", num: 2 },
  { name: "march", num: 3 },
  { name: "april", num: 4 },
  { name: "may", num: 5 },
  { name: "june", num: 6 },
  { name: "july", num: 7 },
  { name: "august", num: 8 },
  { name: "september", num: 9 },
  { name: "october", num: 10 },
  { name: "november", num: 11 },
  { name: "december", num: 12 },
];

const MONTH_SHORT: ReadonlyArray<{ name: string; num: number }> = [
  { name: "jan", num: 1 },
  { name: "feb", num: 2 },
  { name: "mar", num: 3 },
  { name: "apr", num: 4 },
  { name: "may", num: 5 },
  { name: "jun", num: 6 },
  { name: "jul", num: 7 },
  { name: "aug", num: 8 },
  { name: "sep", num: 9 },
  { name: "sept", num: 9 },
  { name: "oct", num: 10 },
  { name: "nov", num: 11 },
  { name: "dec", num: 12 },
];

/**
 * ISO 8601 date — the highest-confidence timing signal.
 * Matches "2026-02-15" anywhere, anchored by word boundaries.
 */
function extractTimingWindow(body: string): Extract[] {
  const out: Extract[] = [];
  // ISO yyyy-mm-dd — 0.90 (exact).
  {
    const re = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
    let m: RegExpExecArray | null = re.exec(body);
    while (m !== null) {
      const [, y, mo, d] = m;
      out.push({
        facet: "TIMING_WINDOW",
        value: { kind: "date", iso: `${y}-${mo}-${d}` },
        confidence: 0.9,
        sourceSpan: { start: m.index, end: m.index + m[0].length },
      });
      m = re.exec(body);
    }
  }
  // "starting in <month>", "available from <month>", "starts <month>",
  // "starting <month>". 0.70 — the month alone pins the window to a
  // coarse range.
  for (const { name, num } of [...MONTHS, ...MONTH_SHORT]) {
    const re = new RegExp(
      `\\b(starting|starts|start|available from|available on|from|in)\\s+${name}\\b`,
      "gi",
    );
    let m: RegExpExecArray | null = re.exec(body);
    while (m !== null) {
      out.push({
        facet: "TIMING_WINDOW",
        value: {
          kind: "month",
          month: num,
          phrase: m[0],
        },
        confidence: 0.7,
        sourceSpan: { start: m.index, end: m.index + m[0].length },
      });
      m = re.exec(body);
    }
  }
  // "booked until", "available after", "can start" — low-confidence
  // context without an explicit calendar date.
  {
    const re = /\b(booked\s+until|available\s+after|can\s+start|starts\s+on)\b/gi;
    let m: RegExpExecArray | null = re.exec(body);
    while (m !== null) {
      out.push({
        facet: "TIMING_WINDOW",
        value: { kind: "phrase", phrase: m[0].toLowerCase() },
        confidence: 0.5,
        sourceSpan: { start: m.index, end: m.index + m[0].length },
      });
      m = re.exec(body);
    }
  }
  return out;
}

// ─── Rate expectation ─────────────────────────────────────────────────

// Unit-identifying keywords — presence of any pins the rate to that
// unit AND lands the high-confidence tier.
const HOUR_KEYWORDS = ["/hr", "/hour", "hourly", "per hour", "an hour"];
const DAY_KEYWORDS = ["/day", "per day", "a day", "daily", "day rate"];
// Context keywords — enough signal to say "yes, this dollar amount is
// a rate" without pinning the unit. Confidence stays high; `unit`
// stays null.
const RATE_CONTEXT_KEYWORDS = ["rate", "pay", "salary", "compensation", "comp"];

function extractRateExpectation(body: string): Extract[] {
  const out: Extract[] = [];
  // "$180/hr", "$1,800/day", "$180 per hour", bare "$180".
  const re = /\$\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?/g;
  let m: RegExpExecArray | null = re.exec(body);
  while (m !== null) {
    const intPart = m[1] ?? "0";
    const amount = Number(intPart.replace(/,/g, "")) + (m[2] ? Number(`0.${m[2]}`) : 0);
    const start = m.index;
    const end = m.index + m[0].length;
    const lower = body.toLowerCase();
    // 40-char windows on each side. We check unit keywords first —
    // the specific hour/day tokens — and only fall back to generic
    // rate-context keywords when neither unit is present. Order
    // matters: "$1,800/day" has "rate" in the `before` window ("day
    // rate is $1,800/day") but the unit comes from "/day" in the
    // `after` window.
    const after = lower.slice(end, end + 40);
    const before = lower.slice(Math.max(0, start - 40), start);
    const window = `${before} ${after}`;
    let unit: "hour" | "day" | null = null;
    if (HOUR_KEYWORDS.some((k) => window.includes(k))) unit = "hour";
    else if (DAY_KEYWORDS.some((k) => window.includes(k))) unit = "day";
    const hasContext = unit !== null || RATE_CONTEXT_KEYWORDS.some((k) => window.includes(k));
    const confidence = hasContext ? 0.9 : 0.5;
    out.push({
      facet: "RATE_EXPECTATION",
      value: { amount, unit, matched: m[0] },
      confidence,
      sourceSpan: { start, end },
    });
    m = re.exec(body);
  }
  return out;
}

// ─── Subspecialty interest ───────────────────────────────────────────

/**
 * Anesthesia subspecialties for the pilot. The ranker side keys off
 * these tokens verbatim (see `signal-match/src/rank.ts`), so the
 * value is the canonical token — "cardiac", "ob", "peds", "pain",
 * "regional", "trauma", "neuro" — not the surface spelling.
 */
const SUBSPECIALTIES: ReadonlyArray<{
  canonical: string;
  patterns: readonly string[];
}> = [
  {
    canonical: "cardiac",
    patterns: ["cardiac", "cardiothoracic", "heart", "cts anesthesia", "ct anesthesia"],
  },
  { canonical: "ob", patterns: ["ob anesthesia", "obstetric", "obstetrics", "l&d", "labor"] },
  { canonical: "peds", patterns: ["pediatric", "peds", "paediatric", "children's anesthesia"] },
  {
    canonical: "pain",
    patterns: ["pain management", "chronic pain", "pain clinic", "pain anesthesia"],
  },
  { canonical: "regional", patterns: ["regional anesthesia", "regional blocks", "nerve block"] },
  { canonical: "neuro", patterns: ["neuroanesthesia", "neuro cases", "neurosurgical anesthesia"] },
  { canonical: "trauma", patterns: ["trauma anesthesia", "trauma cases", "level 1 trauma"] },
];

function extractSubspecialty(body: string): Extract[] {
  const out: Extract[] = [];
  for (const { canonical, patterns } of SUBSPECIALTIES) {
    for (const p of patterns) {
      const re = new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      let m: RegExpExecArray | null = re.exec(body);
      while (m !== null) {
        out.push({
          facet: "SUBSPECIALTY_INTEREST",
          value: { subspecialty: canonical, matched: m[0] },
          // Multi-word surface forms are stronger; single-word
          // ambiguous ones ("heart") get marked medium.
          confidence: p.includes(" ") ? 0.9 : 0.7,
          sourceSpan: { start: m.index, end: m.index + m[0].length },
        });
        m = re.exec(body);
      }
    }
  }
  return out;
}

// ─── Availability signal ─────────────────────────────────────────────

function extractAvailability(body: string): Extract[] {
  const out: Extract[] = [];
  const re =
    /\b(available|availability|open to work|ready to start|free to work|booked until|not available|unavailable|on assignment|no availability)\b/gi;
  let m: RegExpExecArray | null = re.exec(body);
  while (m !== null) {
    const phrase = m[0].toLowerCase();
    // "not available" / "unavailable" / "no availability" flip the
    // polarity. "booked until" implies not-available-now with an
    // upcoming date somewhere nearby — timing extractor catches that
    // half.
    const polarity =
      phrase.startsWith("not") || phrase.startsWith("unavailable") || phrase.startsWith("no ")
        ? "unavailable"
        : phrase.startsWith("booked") || phrase.startsWith("on assignment")
          ? "unavailable"
          : "available";
    out.push({
      facet: "AVAILABILITY_SIGNAL",
      value: { polarity, matched: m[0] },
      // Strong keywords ("available", "unavailable") are exact; the
      // multi-word phrases are also high confidence.
      confidence: 0.9,
      sourceSpan: { start: m.index, end: m.index + m[0].length },
    });
    m = re.exec(body);
  }
  return out;
}

// ─── Top-level ───────────────────────────────────────────────────────

/**
 * Pure extractor: given a conversation body, return every facet we
 * can lift out of it. Order within the returned list is stable
 * (region → timing → rate → subspecialty → availability) so tests
 * can assert on positional equality. Duplicates across facets are
 * fine — different facets at the same span tell the ranker different
 * things.
 *
 * `metadata` is forwarded to the caller untouched; we don't use it
 * in v0 but a future LLM pass may want the conversation channel or
 * occurred_at to disambiguate ("starting in May 2027" vs "starting
 * in May 2026" when the note was written in April 2026).
 */
export function extract(body: string): Extract[] {
  if (!body) return [];
  return [
    ...extractRegionPreference(body),
    ...extractTimingWindow(body),
    ...extractRateExpectation(body),
    ...extractSubspecialty(body),
    ...extractAvailability(body),
  ];
}
