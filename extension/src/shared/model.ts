import {
  CATEGORY_IDS,
  FEATURE_KEYS,
  type CategoryId,
  type Example,
  type Features,
  type Learned,
  type PostData,
  type Rule,
  type RuleScores,
  type Settings,
  type Weights,
} from "./types";

/** Bump when question wording changes so cached features are recomputed. */
export const QUESTIONS_VERSION = 1;

export const CATEGORIES: Record<
  CategoryId,
  { label: string; description: string; question: string; defaultOn: boolean }
> = {
  politics: {
    label: "Politics",
    description: "Politics, elections, government, political figures, culture war",
    question:
      "Is this post about politics: government or policy debates (e.g. immigration, taxes, regulation), elections, politicians, political parties, governments, or culture-war topics? Answer yes even if the post is informative.",
    defaultOn: true,
  },
  rage: {
    label: "Rage bait",
    description: "Written to make people angry, dunk on someone, or stoke tribal outrage",
    question:
      "Is this post rage bait: written to provoke outrage or anger, dunk on someone, or stoke us-vs-them hostility?",
    defaultOn: true,
  },
  provocative: {
    label: "Provocative",
    description: "Inflammatory, insulting, deliberately edgy or hostile tone",
    question: "Is the tone inflammatory, insulting, hostile, or deliberately provocative?",
    defaultOn: true,
  },
  bait: {
    label: "Engagement bait",
    description: "\"Who did it better?\", \"unpopular opinion\", polls and questions posted to farm replies",
    question:
      "Is this engagement farming, such as a 'who did it better / most accurate?' comparison, 'unpopular opinion', a ranking or poll, or a question posted mainly to farm replies?",
    defaultOn: true,
  },
  lowvalue: {
    label: "Low value",
    description: "Memes, fandom and celebrity chatter, shallow reactions, quote tweets that add nothing",
    question:
      "Is this low-effort filler, such as a meme, fandom or celebrity chatter, a shallow one-line reaction, or a quote post that adds nothing, with little to learn from it?",
    defaultOn: true,
  },
  promo: {
    label: "Promo",
    description: "Brand marketing, ads, product hype, self-promotion",
    question: "Is this post mainly brand marketing, advertising, product hype, or self-promotion?",
    defaultOn: true,
  },
  graphic: {
    label: "Graphic",
    description: "Violence, gore, accidents, disturbing footage",
    question: "Does this post show or describe graphic, violent, or disturbing content?",
    defaultOn: false,
  },
};

const SUBSTANCE_QUESTION =
  "Does this post contain substantive information, original insight, technical depth, or useful news that a thoughtful reader would learn from?";

export const DEFAULT_NOTES =
  "I use X for signal, not noise. I want posts that teach me something, share real work, useful news, or genuinely clever humor. I don't want content that eats attention and gives nothing back.";

// ---------------------------------------------------------------------------
// Post -> Clef state
// ---------------------------------------------------------------------------

const PAGE_LABEL: Record<PostData["page"], string> = {
  home: "home feed",
  thread: "replies under a post",
  search: "search results",
  profile: "a profile timeline",
  other: "a timeline",
};

export function postState(post: PostData) {
  const media = post.media.filter((m) => !m.inQuote);
  const quoteMedia = post.media.filter((m) => m.inQuote);
  return {
    platform: "X (Twitter)",
    seen_in: PAGE_LABEL[post.page],
    post: {
      author: `${post.name} (@${post.handle}${post.verified ? ", verified" : ""})`,
      context: post.context,
      text: post.text || "(no text)",
      media: describeMedia(media),
      link_card: post.card,
      poll: post.poll,
      engagement: post.engagement,
    },
    quoted_post: post.quote
      ? {
          author: `${post.quote.name} (@${post.quote.handle})`,
          text: post.quote.text || "(no text)",
          media: describeMedia(quoteMedia),
        }
      : undefined,
  };
}

function describeMedia(media: PostData["media"]) {
  if (!media.length) return undefined;
  return media.map((m) => (m.alt ? `${m.kind}: ${m.alt}` : m.kind)).join(", ");
}

/** One-line summary used for few-shot examples and the "recently hidden" list. */
export function summarize(post: PostData, max = 260): string {
  let s = `@${post.handle}: ${post.text || "(media only)"}`;
  if (post.media.some((m) => !m.inQuote)) s += ` [${post.media.find((m) => !m.inQuote)!.kind}]`;
  if (post.quote) s += ` — quoting @${post.quote.handle}: ${post.quote.text || "(media)"}`;
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** Clef takes at most 64 questions; 9 are built in. */
const MAX_ACTIVE_RULES = 50;
export const activeRules = (rules: Rule[]) => rules.filter((r) => r.enabled).slice(0, MAX_ACTIVE_RULES);
export const ruleKey = (id: string) => `rule_${id}`;

export function profile(settings: Settings, rules: Rule[] = []) {
  const active = activeRules(rules);
  return {
    hide_categories: CATEGORY_IDS.filter((c) => settings.categories[c]).map(
      (c) => `${CATEGORIES[c].label}: ${CATEGORIES[c].description}`,
    ),
    learned_hide_rules: nonEmpty(active.filter((r) => r.kind === "hide").map((r) => r.text)),
    learned_keep_rules: nonEmpty(active.filter((r) => r.kind === "keep").map((r) => r.text)),
    notes: settings.notes.trim() || undefined,
  };
}

const nonEmpty = <T>(a: T[]) => (a.length ? a : undefined);

/** Yes/no questions for a set of rules, keyed `rule_<id>`. */
export function ruleQuestions(rules: Rule[]) {
  const q: Record<string, unknown> = {};
  for (const r of rules) q[ruleKey(r.id)] = { type: "noul", instructions: r.question };
  return q;
}

export function buildQuestions(settings: Settings, hid: string[], kept: string[], rules: Rule[] = []) {
  const questions: Record<string, unknown> = {
    hide: {
      type: "noul",
      instructions: {
        question:
          "Given this reader's preferences and past decisions, would they want this post hidden from their feed? Their hide list applies even when a post is informative; their keep rules override it. Answer no if the post doesn't clearly match anything they avoid.",
        reader_preferences: profile(settings, rules),
        posts_reader_hid: nonEmpty(hid),
        posts_reader_kept: nonEmpty(kept),
      },
      criteria: {
        true: "The reader would rather not see this post",
        false: "The reader would want to see this post, or it's unclear",
      },
    },
    substance: { type: "noul", instructions: SUBSTANCE_QUESTION },
    ...ruleQuestions(activeRules(rules)),
  };
  for (const c of CATEGORY_IDS) questions[c] = { type: "noul", instructions: CATEGORIES[c].question };
  return questions;
}

/** Cache key component: anything that changes the meaning of cached features. */
export function featureVersion(settings: Settings, rules: Rule[] = []): string {
  return hash(
    JSON.stringify([
      QUESTIONS_VERSION,
      settings.model,
      settings.analyzeImages,
      profile(settings, rules),
      activeRules(rules).map((r) => [r.id, r.question]),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Local personalization layer: logistic regression over Clef's probabilities
// ---------------------------------------------------------------------------

const RULE_WEIGHT = 2.0;

export function defaultWeights(settings: Settings, rules: Rule[] = []): Weights {
  const w: Weights = { bias: -0.6, hide: 1.0, substance: -1.0, author: -2.0 };
  for (const c of CATEGORY_IDS) w[c] = settings.categories[c] ? 2.0 : 0;
  for (const r of activeRules(rules)) w[`rule:${r.id}`] = r.kind === "hide" ? RULE_WEIGHT : -RULE_WEIGHT;
  return w;
}

const logit = (p: number) => {
  const q = Math.min(0.995, Math.max(0.005, p));
  return Math.log(q / (1 - q));
};
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function vector(f: Features, affinity: number, ruleScores?: RuleScores, rules: Rule[] = []): Weights {
  const x: Weights = { bias: 1, author: affinity };
  for (const k of FEATURE_KEYS) x[k] = k === "hide" ? logit(f[k]) : f[k];
  // A rule the post was never scored on counts as "doesn't match".
  for (const r of activeRules(rules)) x[`rule:${r.id}`] = ruleScores?.[r.id] ?? 0;
  return x;
}

function dot(w: Weights, x: Weights): number {
  let z = 0;
  for (const k in x) z += (w[k] ?? 0) * x[k];
  return z;
}

/** Author affinity in (-1, 1): positive = you tend to keep them. */
export function affinity(
  authors: Learned["authors"],
  handle: string,
  quoteHandle?: string,
  exclude?: "hide" | "keep",
): number {
  const one = (h: string | undefined, own: boolean) => {
    if (!h) return 0;
    let [keep, hide] = authors[h.toLowerCase()] ?? [0, 0];
    // Leave-one-out when scoring a training example against its own vote.
    if (own && exclude === "keep") keep--;
    if (own && exclude === "hide") hide--;
    return (keep - hide) / (Math.max(0, keep) + Math.max(0, hide) + 2);
  };
  return Math.max(-1, Math.min(1, one(handle, true) + 0.5 * one(quoteHandle, true)));
}

export function score(f: Features, w: Weights, aff: number, ruleScores?: RuleScores, rules: Rule[] = []): number {
  return sigmoid(dot(w, vector(f, aff, ruleScores, rules)));
}

function countAuthors(examples: Example[]) {
  const authors: Learned["authors"] = {};
  for (const e of examples) {
    for (const h of [e.handle, e.quoteHandle]) {
      if (!h) continue;
      const a = (authors[h.toLowerCase()] ??= [0, 0]);
      a[e.label === "keep" ? 0 : 1]++;
    }
  }
  return authors;
}

interface Sample {
  x: Weights;
  y: number;
  /** Wrongly hiding hurts more than wrongly showing. */
  cost: number;
}

const KEEP_COST = 1.4;

function samples(examples: Example[], rules: Rule[], authors: Learned["authors"]): Sample[] {
  return examples
    .filter((e) => e.features)
    .map((e) => ({
      x: vector(e.features!, affinity(authors, e.handle, e.quoteHandle, e.label), e.rules, rules),
      y: e.label === "hide" ? 1 : 0,
      cost: e.label === "keep" ? KEEP_COST : 1,
    }));
}

/** MAP logistic regression, pulled toward the hand-set prior (strongly when there are few votes). */
function train(data: Sample[], w0: Weights, frozen: Set<string>): Weights {
  const w = { ...w0 };
  if (!data.length) return w;
  const lambda = 1 / data.length;
  const lr = 0.08;
  for (let epoch = 0; epoch < 60; epoch++) {
    for (const s of data) {
      const g = (s.y - sigmoid(dot(w, s.x))) * s.cost;
      for (const k in w0) {
        if (frozen.has(k)) continue;
        w[k] += lr * (g * (s.x[k] ?? 0) - lambda * (w[k] - w0[k]));
      }
    }
  }
  return w;
}

const frozenKeys = (settings: Settings) => new Set<string>(CATEGORY_IDS.filter((c) => !settings.categories[c]));

export function fit(examples: Example[], settings: Settings, rules: Rule[] = []): Learned {
  const authors = countAuthors(examples);
  const votes: Learned["votes"] = {};
  for (const e of examples) votes[e.id] = e.label;
  const weights = train(samples(examples, rules, authors), defaultWeights(settings, rules), frozenKeys(settings));
  return { weights, authors, votes, examples: examples.length };
}

/**
 * k-fold cost of the local layer with a given rule set: each wrong hide costs
 * KEEP_COST, each wrong show 1, averaged per vote. Used to accept or reject
 * learned rules on votes they weren't fitted to.
 */
export function crossValidatedCost(examples: Example[], settings: Settings, rules: Rule[], k = 5): number {
  const authors = countAuthors(examples);
  const data = samples(examples, rules, authors);
  if (data.length < 4) return 0;
  const w0 = defaultWeights(settings, rules);
  const frozen = frozenKeys(settings);
  const folds = Math.min(k, data.length);
  let cost = 0;
  for (let f = 0; f < folds; f++) {
    const w = train(data.filter((_, i) => i % folds !== f), w0, frozen);
    for (let i = f; i < data.length; i += folds) {
      const hide = sigmoid(dot(w, data[i].x)) >= settings.threshold;
      if (hide !== (data[i].y === 1)) cost += data[i].cost;
    }
  }
  return cost / data.length;
}

/** What contributed most to a hide, for the label on the hidden bar. */
export function reason(f: Features, w: Weights, settings: Settings, ruleScores?: RuleScores, rules: Rule[] = []): string {
  let best = "Your taste";
  let bestV = 0.35;
  for (const c of CATEGORY_IDS) {
    if (!settings.categories[c]) continue;
    const v = f[c] * Math.max(0.25, w[c]);
    if (f[c] >= 0.5 && v > bestV) {
      best = CATEGORIES[c].label;
      bestV = v;
    }
  }
  for (const r of activeRules(rules)) {
    const p = ruleScores?.[r.id] ?? 0;
    const v = p * Math.max(0.25, w[`rule:${r.id}`] ?? 0);
    if (r.kind === "hide" && p >= 0.5 && v > bestV) {
      best = r.label;
      bestV = v;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Few-shot selection
// ---------------------------------------------------------------------------

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[@#]?[\p{L}\p{N}_]{3,}/gu) ?? []);
}

/** Picks the votes most similar to this post, falling back to the most recent ones. */
export function pickExamples(examples: Example[], summary: string, perLabel = 5) {
  const t = tokens(summary);
  const scored = examples.map((e) => {
    const et = tokens(e.summary);
    let inter = 0;
    for (const x of et) if (t.has(x)) inter++;
    return { e, sim: inter / (t.size + et.size - inter || 1) };
  });
  scored.sort((a, b) => b.sim - a.sim || b.e.ts - a.e.ts);
  const take = (label: "hide" | "keep") =>
    scored.filter((s) => s.e.label === label).slice(0, perLabel).map((s) => s.e.summary);
  return { hid: take("hide"), kept: take("keep") };
}

export function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
