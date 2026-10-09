/**
 * The self-learning loop: votes -> proposed rules -> tested on your votes -> adopted.
 *
 *   1. Propose  A writer model reads your votes (corrections first) and drafts
 *               plain-language hide/keep rules, each with a yes/no question.
 *   2. Test     Clef answers every candidate question on your past voted posts
 *               in one call per post (up to 64 questions per call).
 *   3. Adopt    A rule survives only if it matches your votes precisely, and
 *               adding it doesn't make held-out decisions worse (k-fold, with
 *               wrong hides costing more than wrong shows).
 *
 * Runtime-agnostic: the extension and scripts inject the model calls.
 */
import {
  CATEGORIES,
  activeRules,
  affinity,
  crossValidatedCost,
  fit,
  postState,
  ruleKey,
  ruleQuestions,
  score,
} from "./model";
import { CATEGORY_IDS, type Example, type LearnState, type Rule, type Settings } from "./types";

export const MIN_VOTES = 12;
const MIN_HIDES = 4;
/** Re-learn after this many new votes (when auto-learning is on). */
export const LEARN_EVERY = 25;
const MAX_EVAL = 300;
const MAX_PROMPT_VOTES = 160;
const MAX_CANDIDATES = 8;
const MAX_LEARNED_RULES = 20;
const MIN_SUPPORT = 3;
const MAX_IMPURITY = 0.2;
const CONCURRENCY = 6;

export interface LearnDeps {
  /** Runs Clef on { state, questions }; the caller adds the model. */
  clef: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  writer: <T>(messages: { role: "system" | "user"; content: string }[], schema: Record<string, unknown>) => Promise<T>;
  progress: (message: string) => void | Promise<void>;
}

export interface LearnResult {
  rules: Rule[];
  /** Updated rule scores per example id (merge into the latest examples). */
  ruleScores: Record<string, Record<string, number>>;
  report: NonNullable<LearnState["report"]>;
}

export async function learnRules(
  input: { examples: Example[]; rules: Rule[]; settings: Settings },
  deps: LearnDeps,
): Promise<LearnResult> {
  const { settings } = input;
  const examples = input.examples.map((e) => ({ ...e, rules: { ...e.rules } }));
  const hides = examples.filter((e) => e.label === "hide").length;
  if (examples.length < MIN_VOTES || hides < MIN_HIDES)
    throw new Error(`Need at least ${MIN_VOTES} votes with ${MIN_HIDES} 👎 to learn from (have ${examples.length}, ${hides} 👎).`);

  // 1. Propose ---------------------------------------------------------------
  await deps.progress("Reading your votes…");
  const enabled = activeRules(input.rules);
  const disabled = input.rules.filter((r) => !r.enabled);
  const corrections = findCorrections(examples, settings, input.rules);
  const drafted = await propose(examples, corrections, enabled, disabled, settings, deps);
  const known = new Set(input.rules.map((r) => norm(r.question)));
  const candidates: Rule[] = drafted
    .filter((d) => !known.has(norm(d.question)))
    .slice(0, MAX_CANDIDATES)
    .map((d) => ({
      id: Math.random().toString(36).slice(2, 8),
      kind: d.kind,
      label: d.label.slice(0, 32),
      text: d.text,
      question: d.question,
      source: "learned" as const,
      enabled: true,
      createdAt: Date.now(),
    }));

  // 2. Test ------------------------------------------------------------------
  const pool = [...enabled, ...candidates];
  const evaluated = examples.slice(-MAX_EVAL);
  if (pool.length) await evaluate(evaluated, pool, deps);
  for (const r of pool) r.stats = stats(evaluated, r);

  // 3. Adopt -----------------------------------------------------------------
  // Learned rules that no longer match your votes retire; yours always stay.
  const kept = enabled.filter((r) => r.source === "user" || precise(r));
  const retired = enabled.filter((r) => !kept.includes(r));
  const base = [...kept, ...disabled];
  const errorBefore = crossValidatedCost(evaluated, settings, input.rules);
  let current = base;
  let cost = crossValidatedCost(evaluated, settings, current);
  const added: Rule[] = [];

  const ranked = candidates
    .filter(precise)
    .map((r) => ({ r, fixes: fixes(r, evaluated, corrections) }))
    .sort((a, b) => b.fixes - a.fixes || support(b.r) - support(a.r));
  await deps.progress(`Testing ${ranked.length} promising rule${ranked.length === 1 ? "" : "s"} against held-out votes…`);
  for (const { r } of ranked) {
    if (activeRules(current).filter((x) => x.source === "learned").length >= MAX_LEARNED_RULES) break;
    const trial = [...current, r];
    const c = crossValidatedCost(evaluated, settings, trial);
    if (c <= cost + 1e-9) {
      current = trial;
      cost = c;
      added.push(r);
    }
  }

  const ruleScores: LearnResult["ruleScores"] = {};
  for (const e of evaluated) ruleScores[e.id] = e.rules ?? {};
  return {
    rules: current,
    ruleScores,
    report: {
      votes: examples.length,
      proposed: candidates.length,
      added: added.map((r) => r.label),
      retired: retired.map((r) => r.label),
      errorBefore,
      errorAfter: cost,
    },
  };
}

// ---------------------------------------------------------------------------

/** Votes the current filter would have gotten wrong; the most informative ones. */
function findCorrections(examples: Example[], settings: Settings, rules: Rule[]): Set<string> {
  const learned = fit(examples, settings, rules);
  const out = new Set<string>();
  for (const e of examples) {
    if (!e.features) continue;
    const s = score(e.features, learned.weights, affinity(learned.authors, e.handle, e.quoteHandle, e.label), e.rules, rules);
    if ((s >= settings.threshold) !== (e.label === "hide")) out.add(e.id);
  }
  return out;
}

interface Draft {
  kind: "hide" | "keep";
  label: string;
  text: string;
  question: string;
  evidence: number[];
}

const SYSTEM = `You study one person's votes on X (Twitter) posts and write the rules behind their taste.

Each vote is HIDE (they don't want to see posts like it) or KEEP (they do). Votes marked [MISSED] are where their current filter got it wrong; those matter most.

Write rules that a separate yes/no classifier will apply to every post in their feed:
- Each rule describes something observable in the post itself: topic, format, intent, tone, or what it offers the reader. Not just who posted it (authors are handled separately).
- A rule must generalize across at least 3 votes. Cite them by number in "evidence".
- HIDE rules capture a pattern they consistently reject. KEEP rules are exceptions that protect posts they value even when those posts touch a hidden category (e.g. "Keep news about AI regulation"). Missing a KEEP pattern means the filter over-captures, which is worse than under-capturing.
- Don't restate the built-in categories as they are. Only propose them when you can make them sharper or narrower.
- "question" is a single yes/no question answerable from the post alone, where "yes" means the rule applies. Describe the idea, not keywords: it must still work for posts that say the same thing in different words or another language. No long and/or chains or lists of example phrases.
- "label" is 2–4 words for a small UI chip ("Car launch hype"). "text" is one sentence starting with "Hide" or "Keep".
- Propose at most ${MAX_CANDIDATES} rules. Fewer is better than vague. Return an empty list if no clear pattern exists.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rules"],
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "label", "text", "question", "evidence"],
        properties: {
          kind: { type: "string", enum: ["hide", "keep"] },
          label: { type: "string" },
          text: { type: "string" },
          question: { type: "string" },
          evidence: { type: "array", items: { type: "integer" } },
        },
      },
    },
  },
};

async function propose(
  examples: Example[],
  corrections: Set<string>,
  enabled: Rule[],
  disabled: Rule[],
  settings: Settings,
  deps: LearnDeps,
): Promise<Draft[]> {
  // Corrections first, then the most recent votes.
  const ordered = [
    ...examples.filter((e) => corrections.has(e.id)),
    ...examples.filter((e) => !corrections.has(e.id)).reverse(),
  ].slice(0, MAX_PROMPT_VOTES);
  const votes = ordered
    .map((e, i) => `${i + 1}. ${e.label.toUpperCase()}${corrections.has(e.id) ? " [MISSED]" : ""} ${e.summary}`)
    .join("\n");
  const builtIn = CATEGORY_IDS.filter((c) => settings.categories[c])
    .map((c) => `- ${CATEGORIES[c].label}: ${CATEGORIES[c].description}`)
    .join("\n");
  const ruleLine = (r: Rule) =>
    `- [${r.kind}] ${r.text}${r.stats ? ` (matched ${r.stats.hide}/${r.stats.ofHide} HIDE, ${r.stats.keep}/${r.stats.ofKeep} KEEP)` : ""}`;

  const user = [
    `Built-in categories already filtered:\n${builtIn || "(none)"}`,
    settings.notes.trim() ? `Their own description of their taste:\n${settings.notes.trim()}` : "",
    enabled.length ? `Rules already in use (don't repeat; propose better ones only if these miss something):\n${enabled.map(ruleLine).join("\n")}` : "",
    disabled.length ? `Rules they turned off (never propose these again):\n${disabled.map(ruleLine).join("\n")}` : "",
    `Votes:\n${votes}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  await deps.progress(`Looking for patterns in ${ordered.length} votes…`);
  const out = await deps.writer<{ rules: Draft[] }>(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    SCHEMA,
  );
  return (out.rules ?? []).filter((d) => d.question?.trim() && d.text?.trim() && d.label?.trim());
}

/** Asks Clef every pool question on every example, writing scores into e.rules. */
async function evaluate(examples: Example[], pool: Rule[], deps: LearnDeps) {
  const questions = ruleQuestions(pool);
  let done = 0;
  let failed = 0;
  const queue = [...examples];
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      try {
        // Text only: old votes may predate full-post storage, and images would 10x the cost.
        const out = await deps.clef({ state: e.post ? postState(e.post) : { post: e.summary }, questions });
        const answers = out.answers as Record<string, { noul?: number }>;
        for (const r of pool) {
          const p = answers?.[ruleKey(r.id)]?.noul;
          if (typeof p === "number") e.rules![r.id] = p;
        }
      } catch {
        failed++;
      }
      if (++done % 10 === 0) await deps.progress(`Testing rules on your votes… ${done}/${examples.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (failed > examples.length * 0.3) throw new Error(`Clef failed on ${failed} of ${examples.length} votes; try again later.`);
}

function stats(examples: Example[], r: Rule): NonNullable<Rule["stats"]> {
  const s = { hide: 0, keep: 0, ofHide: 0, ofKeep: 0 };
  for (const e of examples) {
    const p = e.rules?.[r.id];
    if (p === undefined) continue;
    if (e.label === "hide") {
      s.ofHide++;
      if (p >= 0.5) s.hide++;
    } else {
      s.ofKeep++;
      if (p >= 0.5) s.keep++;
    }
  }
  return s;
}

const support = (r: Rule) => (r.kind === "hide" ? r.stats!.hide : r.stats!.keep);

/** Matches enough of its own side, and rarely the other side. */
function precise(r: Rule): boolean {
  if (!r.stats) return false;
  const own = support(r);
  const other = r.kind === "hide" ? r.stats.keep : r.stats.hide;
  return own >= MIN_SUPPORT && other / (own + other) <= MAX_IMPURITY;
}

/** How many current mistakes this rule points the right way on. */
function fixes(r: Rule, examples: Example[], corrections: Set<string>): number {
  let n = 0;
  for (const e of examples) {
    if (!corrections.has(e.id) || (e.rules?.[r.id] ?? 0) < 0.5) continue;
    if (e.label === r.kind) n++;
  }
  return n;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
