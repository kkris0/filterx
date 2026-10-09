export const CATEGORY_IDS = [
  "politics",
  "rage",
  "provocative",
  "bait",
  "lowvalue",
  "promo",
  "graphic",
] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

/** Every probability Clef returns for a post. */
export const FEATURE_KEYS = ["hide", ...CATEGORY_IDS, "substance"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type Features = Record<FeatureKey, number>;

export type Label = "hide" | "keep";
export type ModelId = "clef" | "clef-flash";

export interface PostMedia {
  kind: "photo" | "video" | "gif" | "card";
  url: string;
  alt?: string;
  inQuote: boolean;
}

export interface QuotedPost {
  name: string;
  handle: string;
  text: string;
}

/** What the content script extracts from one rendered post. */
export interface PostData {
  id: string;
  url: string;
  name: string;
  handle: string;
  verified: boolean;
  text: string;
  /** "X reposted", "Pinned", ... */
  context?: string;
  page: "home" | "thread" | "search" | "profile" | "other";
  quote?: QuotedPost;
  card?: string;
  poll?: string;
  media: PostMedia[];
  /** The action bar's aria-label, e.g. "38 replies, 178 reposts, 5103 likes, 99135 views". */
  engagement?: string;
}

export interface Settings {
  enabled: boolean;
  connection: {
    mode: "worker" | "direct";
    workerUrl: string;
    secret: string;
    accountId: string;
    apiToken: string;
  };
  model: ModelId;
  /** Hide when the final score is at or above this. */
  threshold: number;
  display: "collapse" | "remove";
  categories: Record<CategoryId, boolean>;
  /** Free-text taste description passed to the personal question. */
  notes: string;
  analyzeImages: boolean;
  /** On 👎 also click X's own "Not interested in this post". */
  syncNotInterested: boolean;
  /** Re-learn rules automatically every LEARN_EVERY new votes. */
  autoLearn: boolean;
}

/** Probability per rule id, from Clef. */
export type RuleScores = Record<string, number>;

/**
 * A learned (or user-written) direction, asked to Clef as its own yes/no
 * question on every post. Hide rules push toward hiding, keep rules protect.
 */
export interface Rule {
  id: string;
  kind: Label;
  /** Short label for the hidden bar, e.g. "Car launch hype". */
  label: string;
  /** Plain-language rule shown in settings. */
  text: string;
  /** The yes/no question Clef answers. */
  question: string;
  source: "learned" | "user";
  enabled: boolean;
  /** From the last evaluation over your votes: how many 👎 / 👍 posts it matched. */
  stats?: { hide: number; keep: number; ofHide: number; ofKeep: number };
  createdAt: number;
}

export interface LearnState {
  status: "idle" | "running" | "error";
  message?: string;
  at?: number;
  /** Vote count at the last successful run, for auto-learning. */
  votesAtLearn?: number;
  report?: { votes: number; proposed: number; added: string[]; retired: string[]; errorBefore: number; errorAfter: number };
}

/** A user vote, kept for few-shot context, rule learning, and refitting the local layer. */
export interface Example {
  id: string;
  label: Label;
  summary: string;
  handle: string;
  quoteHandle?: string;
  /** The full extracted post, so new rules can be tested against old votes. */
  post?: PostData;
  features?: Features;
  rules?: RuleScores;
  ts: number;
}

/** Keys: FeatureKey | "author" | "bias" | `rule:${id}`. */
export type Weights = Record<string, number>;

export interface Learned {
  weights: Weights;
  /** handle -> [keeps, hides] */
  authors: Record<string, [number, number]>;
  /** post id -> explicit vote */
  votes: Record<string, Label>;
  examples: number;
}

export interface HiddenRecord {
  id: string;
  url: string;
  handle: string;
  summary: string;
  reason: string;
  score: number;
  features: Features;
  rules?: RuleScores;
  quoteHandle?: string;
  post?: PostData;
  ts: number;
}

export interface Stats {
  day: string;
  analyzed: number;
  hidden: number;
  cached: number;
  errors: number;
  latencyTotal: number;
}

export interface ClassifyResult {
  features?: Features;
  rules?: RuleScores;
  ms?: number;
  cached?: boolean;
  error?: string;
}

export type Message =
  | { type: "classify"; post: PostData }
  | { type: "vote"; post: PostData; label: Label; features?: Features; rules?: RuleScores }
  | { type: "unvote"; id: string }
  | { type: "hidden"; record: HiddenRecord }
  | { type: "learn" }
  | { type: "test" };
