import { callClef, callWriter } from "./shared/api";
import { LEARN_EVERY, MIN_VOTES, learnRules } from "./shared/learn";
import {
  activeRules,
  buildQuestions,
  featureVersion,
  fit,
  pickExamples,
  postState,
  ruleKey,
  summarize,
} from "./shared/model";
import { emptyStats, isConfigured, loadRules, loadSettings, today } from "./shared/settings";
import {
  FEATURE_KEYS,
  type ClassifyResult,
  type Example,
  type Features,
  type HiddenRecord,
  type LearnState,
  type Message,
  type PostData,
  type Rule,
  type RuleScores,
  type Settings,
  type Stats,
} from "./shared/types";

const MAX_EXAMPLES = 600;
const MAX_CACHE = 4000;
const MAX_RECENT = 40;
const IMAGE_TIMEOUT_MS = 1_500;
const IMAGE_MAX_DIM = 512;
/** Total base64 characters across images (~40k estimated tokens, well under 64k). */
const IMAGE_BUDGET_CHARS = 160_000;

// ---------------------------------------------------------------------------
// State (service workers can be killed at any time, so everything is lazily
// reloaded from storage and written back debounced)
// ---------------------------------------------------------------------------

type CacheEntry = { f: Features; r?: RuleScores; v: string; t: number };
let cache: Map<string, CacheEntry> | null = null;
let settingsP: Promise<Settings> | null = null;
let examplesP: Promise<Example[]> | null = null;
let rulesP: Promise<Rule[]> | null = null;
const inflight = new Map<string, Promise<ClassifyResult>>();

const settings = () => (settingsP ??= loadSettings());
const rules = () => (rulesP ??= loadRules());
const examples = () =>
  (examplesP ??= chrome.storage.local.get("examples").then((r) => (r.examples as Example[]) ?? []));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    settingsP = null;
    // Category toggles change the prior, so the learned layer must be refit.
    void refit();
  }
  if (changes.examples) {
    // Votes from any page (content, popup, options import/delete) refit the layer.
    examplesP = null;
    void refit();
  }
  if (changes.rules) {
    rulesP = null;
    void refit();
  }
  if (changes.cache && !changes.cache.newValue) cache = null;
});

async function getCache() {
  if (cache) return cache;
  const { cache: stored } = await chrome.storage.local.get("cache");
  cache = new Map(Object.entries((stored as Record<string, CacheEntry>) ?? {}));
  return cache;
}

let cacheTimer: ReturnType<typeof setTimeout> | undefined;
function persistCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(async () => {
    const c = await getCache();
    if (c.size > MAX_CACHE) {
      const oldest = [...c.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, c.size - MAX_CACHE);
      for (const [k] of oldest) c.delete(k);
    }
    await chrome.storage.local.set({ cache: Object.fromEntries(c) });
  }, 2_000);
}

let statsQueue: Partial<Stats>[] = [];
let statsTimer: ReturnType<typeof setTimeout> | undefined;
function bumpStats(delta: Partial<Stats>) {
  statsQueue.push(delta);
  clearTimeout(statsTimer);
  statsTimer = setTimeout(async () => {
    const queued = statsQueue;
    statsQueue = [];
    const { stats } = (await chrome.storage.local.get("stats")) as { stats?: Stats };
    const s: Stats = stats?.day === today() ? stats : emptyStats();
    for (const d of queued)
      for (const k of ["analyzed", "hidden", "cached", "errors", "latencyTotal"] as const)
        s[k] += d[k] ?? 0;
    await chrome.storage.local.set({ stats: s });
  }, 1_000);
}

// ---------------------------------------------------------------------------
// Clef
// ---------------------------------------------------------------------------

async function classify(post: PostData): Promise<ClassifyResult> {
  const s = await settings();
  if (!isConfigured(s)) return { error: "not-configured" };
  const rs = await rules();
  const version = featureVersion(s, rs);
  const c = await getCache();
  const hit = c.get(post.id);
  if (hit && hit.v === version) {
    bumpStats({ cached: 1 });
    return { features: hit.f, rules: hit.r, cached: true, ms: 0 };
  }

  const key = `${post.id}:${version}`;
  let p = inflight.get(key);
  if (!p) {
    p = runClef(post, s, rs)
      .then((res) => {
        if (res.features) {
          c.set(post.id, { f: res.features, r: res.rules, v: version, t: Date.now() });
          persistCache();
          bumpStats({ analyzed: 1, latencyTotal: res.ms ?? 0 });
        }
        return res;
      })
      .catch((e: unknown) => {
        bumpStats({ errors: 1 });
        return { error: e instanceof Error ? e.message : String(e) };
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function runClef(post: PostData, s: Settings, rs: Rule[]): Promise<ClassifyResult> {
  const t0 = performance.now();
  const summary = summarize(post);
  const { hid, kept } = pickExamples(await examples(), summary);
  const images = s.analyzeImages ? await fetchImages(post) : [];

  const body: Record<string, unknown> = {
    model: s.model,
    state: postState(post),
    questions: buildQuestions(s, hid, kept, rs),
  };
  if (images.length) body.images = images;

  const json = await callClef(body, s);
  const answers = json.answers as Record<string, { noul?: number }> | undefined;
  if (!answers) throw new Error("Clef returned no answers");
  const features = {} as Features;
  for (const k of FEATURE_KEYS) features[k] = answers[k]?.noul ?? 0;
  const ruleScores: RuleScores = {};
  for (const r of activeRules(rs)) ruleScores[r.id] = answers[ruleKey(r.id)]?.noul ?? 0;
  return { features, rules: ruleScores, ms: Math.round(performance.now() - t0) };
}

/**
 * Up to 4 post images (main post first), downscaled to small JPEGs. Workers AI
 * estimates image tokens from the base64 size, so a full-size image alone
 * overflows Clef's 64k context; ~512px JPEGs cost ~250 real tokens each.
 */
async function fetchImages(post: PostData): Promise<string[]> {
  const urls = [...post.media]
    .sort((a, b) => Number(a.inQuote) - Number(b.inQuote) || Number(a.kind === "card") - Number(b.kind === "card"))
    .slice(0, 4)
    .map((m) => sizedUrl(m.url));
  const out = await Promise.all(urls.map((u) => fetchDataUrl(u).catch(() => null)));
  const kept: string[] = [];
  let budget = IMAGE_BUDGET_CHARS;
  for (const img of out) {
    if (!img || img.length > budget) continue;
    kept.push(img);
    budget -= img.length;
  }
  return kept;
}

function sizedUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.hostname === "pbs.twimg.com" && !u.pathname.startsWith("/profile_images")) {
      u.searchParams.set("name", "small");
      if (!u.searchParams.has("format") && !/\.\w+$/.test(u.pathname)) u.searchParams.set("format", "jpg");
    }
    return u.toString();
  } catch {
    return raw;
  }
}

async function fetchDataUrl(url: string): Promise<string | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob());
  const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.65 });
  const buf = new Uint8Array(await jpeg.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(bin)}`;
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

async function refit() {
  const [s, ex, rs] = await Promise.all([settings(), examples(), rules()]);
  await chrome.storage.local.set({ learned: fit(ex, s, rs) });
}

async function vote(msg: Extract<Message, { type: "vote" }>) {
  const ex = (await examples()).filter((e) => e.id !== msg.post.id);
  let { features, rules: ruleScores } = msg;
  if (!features) {
    const hit = (await getCache()).get(msg.post.id);
    if (hit?.v === featureVersion(await settings(), await rules())) ({ f: features, r: ruleScores } = hit);
  }
  ex.push({
    id: msg.post.id,
    label: msg.label,
    summary: summarize(msg.post),
    handle: msg.post.handle,
    quoteHandle: msg.post.quote?.handle,
    post: msg.post,
    features,
    rules: ruleScores,
    ts: Date.now(),
  });
  await saveExamples(ex.slice(-MAX_EXAMPLES));
  void maybeAutoLearn(ex.length);
}

// ---------------------------------------------------------------------------
// Rule learning (see shared/learn.ts)
// ---------------------------------------------------------------------------

let learning: Promise<LearnState> | null = null;

async function getLearnState(): Promise<LearnState> {
  const { learn } = (await chrome.storage.local.get("learn")) as { learn?: LearnState };
  return learn ?? { status: "idle" };
}

async function setLearnState(patch: Partial<LearnState>) {
  await chrome.storage.local.set({ learn: { ...(await getLearnState()), ...patch } });
}

async function maybeAutoLearn(votes: number) {
  const s = await settings();
  if (!s.autoLearn || !isConfigured(s) || votes < MIN_VOTES) return;
  const state = await getLearnState();
  if (votes - (state.votesAtLearn ?? 0) >= LEARN_EVERY) void learn();
}

function learn(): Promise<LearnState> {
  return (learning ??= runLearn().finally(() => (learning = null)));
}

async function runLearn(): Promise<LearnState> {
  const s = await settings();
  if (!isConfigured(s)) return { status: "error", message: "Connect Clef first." };
  await setLearnState({ status: "running", message: "Starting…" });
  // An MV3 service worker idles out after 30s without extension API calls.
  const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  try {
    const result = await learnRules(
      { examples: await examples(), rules: await rules(), settings: s },
      {
        clef: (body) => callClef({ ...body, model: s.model }, s),
        writer: (messages, schema) => callWriter(messages, schema, s),
        progress: (message) => setLearnState({ status: "running", message }),
      },
    );
    // Votes may have arrived while learning; merge scores into the latest list.
    const latest = await examples();
    const merged = latest.map((e) => (result.ruleScores[e.id] ? { ...e, rules: { ...e.rules, ...result.ruleScores[e.id] } } : e));
    examplesP = Promise.resolve(merged);
    rulesP = Promise.resolve(result.rules);
    await chrome.storage.local.set({ examples: merged, rules: result.rules });
    const state: LearnState = {
      status: "idle",
      message: undefined,
      at: Date.now(),
      votesAtLearn: latest.length,
      report: result.report,
    };
    await setLearnState(state);
    return state;
  } catch (e) {
    const state: LearnState = { status: "error", message: e instanceof Error ? e.message : String(e) };
    await setLearnState(state);
    return state;
  } finally {
    clearInterval(keepAlive);
  }
}

async function unvote(id: string) {
  await saveExamples((await examples()).filter((e) => e.id !== id));
}

async function saveExamples(ex: Example[]) {
  examplesP = Promise.resolve(ex);
  await chrome.storage.local.set({ examples: ex }); // onChanged refits
}

async function recordHidden(record: HiddenRecord) {
  const { recent = [] } = (await chrome.storage.local.get("recent")) as { recent?: HiddenRecord[] };
  if (recent.some((r) => r.id === record.id)) return;
  recent.unshift(record);
  await chrome.storage.local.set({ recent: recent.slice(0, MAX_RECENT) });
  bumpStats({ hidden: 1 });
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

const SAMPLE_POST: PostData = {
  id: "filterx-connection-test",
  url: "",
  name: "ComicFan",
  handle: "comicfan_",
  verified: true,
  text: "Who gave us the most accurate Lex Luthor?",
  page: "home",
  media: [],
};

chrome.runtime.onMessage.addListener((msg: Message, _sender, reply) => {
  const run = async (): Promise<unknown> => {
    switch (msg.type) {
      case "classify":
        return classify(msg.post);
      case "vote":
        return vote(msg);
      case "unvote":
        return unvote(msg.id);
      case "hidden":
        return recordHidden(msg.record);
      case "learn":
        return learn();
      case "test": {
        const s = await settings();
        if (!isConfigured(s)) return { error: "Add a Worker URL or Cloudflare credentials first." };
        const t0 = performance.now();
        try {
          const r = await runClef(SAMPLE_POST, s, await rules());
          return { ...r, ms: Math.round(performance.now() - t0) };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      }
    }
  };
  run().then(reply, (e) => reply({ error: String(e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") await chrome.runtime.openOptionsPage();
  // A learn run interrupted by an extension reload would otherwise look stuck.
  const state = await getLearnState();
  if (state.status === "running") await setLearnState({ status: "idle", message: undefined });
});
