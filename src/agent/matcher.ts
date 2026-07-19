// Prescribed fuzzy menu matcher (SPEC.md §4.1). Do not redesign the pipeline
// or the scoring weights — they are pinned by tests/matcher.test.ts.

export interface MatchableItem {
  id: string;
  name: string;
}

export interface ScoredCandidate {
  id: string;
  name: string;
  score: number;
}

export type MatchStatus = "match" | "ambiguous" | "candidates" | "not_found";

export interface MatchResult {
  status: MatchStatus;
  item?: ScoredCandidate;
  candidates?: ScoredCandidate[];
  detectedSize?: string;
  detectedNegations: string[];
}

const STOP_WORDS = new Set(
  "a an the of with and please me get i want like can have order one two three some gimme lemme add for to extra your my that uh um".split(
    " ",
  ),
);

const SIZE_WORDS = new Set(["small", "medium", "large", "xl", "personal", "family"]);

const NEGATION_TRIGGERS = new Set(["no", "without", "minus"]);

const SYNONYMS: Record<string, string> = {
  za: "pizza",
  pie: "pizza",
  pop: "soda",
  coke: "cola",
  hoagie: "sub",
  hero: "sub",
  grinder: "sub",
  sammich: "sandwich",
  burg: "burger",
};

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(raw: string): string[] {
  const n = normalize(raw);
  return n.length === 0 ? [] : n.split(" ");
}

interface ExtractResult {
  tokens: string[];
  negations: string[];
}

function isStopLikeForCapture(tok: string): boolean {
  return STOP_WORDS.has(tok) || SIZE_WORDS.has(tok) || NEGATION_TRIGGERS.has(tok) || tok === "hold";
}

function extractNegations(tokens: string[]): ExtractResult {
  const negations: string[] = [];
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok === "hold" && tokens[i + 1] === "the" && i + 2 < tokens.length) {
      const target = tokens[i + 2];
      if (!isStopLikeForCapture(target)) {
        negations.push(target);
        i += 3;
        continue;
      }
    }

    if (NEGATION_TRIGGERS.has(tok) && i + 1 < tokens.length) {
      const target = tokens[i + 1];
      if (!isStopLikeForCapture(target)) {
        negations.push(target);
        i += 2;
        continue;
      }
    }

    out.push(tok);
    i += 1;
  }
  return { tokens: out, negations };
}

function extractSize(tokens: string[]): { tokens: string[]; size?: string } {
  const idx = tokens.findIndex((t) => SIZE_WORDS.has(t));
  if (idx === -1) return { tokens, size: undefined };
  const size = tokens[idx];
  const out = tokens.slice(0, idx).concat(tokens.slice(idx + 1));
  return { tokens: out, size };
}

function removeStopWords(tokens: string[]): string[] {
  return tokens.filter((t) => !STOP_WORDS.has(t));
}

function applySynonyms(tokens: string[]): string[] {
  return tokens.map((t) => SYNONYMS[t] ?? t);
}

function buildQueryTokens(raw: string): { tokens: string[]; negations: string[]; size?: string } {
  const rawTokens = tokenize(raw);
  const { tokens: afterNeg, negations } = extractNegations(rawTokens);
  const { tokens: afterSize, size } = extractSize(afterNeg);
  const afterStop = removeStopWords(afterSize);
  const tokens = applySynonyms(afterStop);
  return { tokens, negations, size };
}

/** Levenshtein edit distance; early-exit (Infinity) if length diff > 3. */
function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return Infinity;
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  const minLen = Math.min(a.length, b.length);
  const lenDiff = Math.abs(a.length - b.length);
  if (lenDiff <= 3) {
    const d = levenshtein(a, b);
    if (d === 1 && minLen >= 4) return 0.85;
    if (d === 2 && minLen >= 6) return 0.8;
  }
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 3 && longer.startsWith(shorter)) return 0.7;
  return 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function bestSim(token: string, against: string[]): number {
  if (against.length === 0) return 0;
  let best = 0;
  for (const t of against) {
    const s = tokenSimilarity(token, t);
    if (s > best) best = s;
  }
  return best;
}

/**
 * nameCoverage: for every word the caller actually said, is it found in the
 * item's name? (extra name words the caller never said don't drag this down)
 * queryCoverage: the reverse — for every word in the item's name, did the
 * caller say something like it? Weighted lower so a verbose/partial caller
 * utterance still lands on the right item.
 */
function scoreItem(queryTokens: string[], nameTokens: string[]): number {
  if (queryTokens.length === 0 || nameTokens.length === 0) return 0;
  const nameCoverage = mean(queryTokens.map((qt) => bestSim(qt, nameTokens)));
  const queryCoverage = mean(nameTokens.map((nt) => bestSim(nt, queryTokens)));
  return Math.round(100 * (0.75 * nameCoverage + 0.25 * queryCoverage));
}

export interface ScoreAllResult {
  scored: ScoredCandidate[];
  detectedSize?: string;
  detectedNegations: string[];
}

/** Exposes the full ranked score list (used by scripts/score-table.ts for eyeballing). */
export function scoreAllItems(raw: string, items: MatchableItem[]): ScoreAllResult {
  const { tokens: queryTokens, negations, size } = buildQueryTokens(raw);
  const scored: ScoredCandidate[] = items.map((item) => ({
    id: item.id,
    name: item.name,
    score: scoreItem(queryTokens, tokenize(item.name)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return { scored, detectedSize: size, detectedNegations: negations };
}

export function matchMenuItem(raw: string, items: MatchableItem[]): MatchResult {
  const { scored, detectedSize: size, detectedNegations: negations } = scoreAllItems(raw, items);

  const top = scored[0];
  const second = scored[1];

  if (!top || top.score < 45) {
    return { status: "not_found", detectedSize: size, detectedNegations: negations };
  }

  if (top.score >= 70) {
    if (second && second.score >= 70 && top.score - second.score <= 12) {
      return {
        status: "ambiguous",
        candidates: scored.slice(0, 3),
        detectedSize: size,
        detectedNegations: negations,
      };
    }
    return { status: "match", item: top, detectedSize: size, detectedNegations: negations };
  }

  return {
    status: "candidates",
    candidates: scored.slice(0, 3),
    detectedSize: size,
    detectedNegations: negations,
  };
}
