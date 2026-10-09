import { activeRules, affinity, featureVersion, reason, score, summarize, CATEGORIES } from "../shared/model";
import { loadLearned, loadRules, loadSettings, mergeSettings } from "../shared/settings";
import {
  CATEGORY_IDS,
  type ClassifyResult,
  type Features,
  type Label,
  type Learned,
  type Message,
  type Rule,
  type RuleScores,
  type PostData,
  type Settings,
} from "../shared/types";
import {
  ARTICLE_SELECTOR,
  cellOf,
  detectTheme,
  extractPost,
  focalId,
  isPostArticle,
  ownHandle,
  pageIsExcluded,
  postIdOf,
  voteAnchorOf,
} from "./dom";
import { createBar, createSlot, updateBar, updateSlot } from "./ui";
import { markNotInterested } from "./xactions";

const MAX_IN_FLIGHT = 6;

type View = "shown" | "soft" | "hidden";
/** mount: decided before first paint, so hiding can't shift anything the user saw.
 *  async: a verdict that arrived later; dim instead of collapsing under the reader.
 *  user: the user asked for it. */
type Cause = "mount" | "async" | "user";

interface Rec {
  id: string;
  article: HTMLElement;
  post: PostData;
  features?: Features;
  ruleScores?: RuleScores;
  /** Questions changed; keep showing the old verdict until the new one lands. */
  stale?: boolean;
  skip: boolean;
  view: View;
  slot?: HTMLElement;
  bar?: HTMLElement;
}

let settings: Settings;
let learned: Learned;
let rules: Rule[] = [];
let version = "";
let configured = true;

const recs = new Map<HTMLElement, Rec>();
const memo = new Map<string, { f: Features; r?: RuleScores }>();
const revealed = new Set<string>();
const reported = new Set<string>();
const queue: Rec[] = [];
let inFlight = 0;

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  // rAF runs before the next paint, so verdicts we already know are applied
  // before a freshly mounted post is ever drawn.
  requestAnimationFrame(() => {
    scheduled = false;
    scan();
  });
}

function scan() {
  if (!settings.enabled || pageIsExcluded()) {
    if (recs.size) resetAll();
    return;
  }
  for (const article of document.querySelectorAll<HTMLElement>(ARTICLE_SELECTOR)) {
    if (!isPostArticle(article)) continue;
    const id = postIdOf(article);
    if (!id) continue;
    const rec = recs.get(article);
    if (rec && rec.id === id) ensureDecor(rec);
    else {
      if (rec) teardown(rec);
      mount(article, id);
    }
  }
  for (const [article, rec] of recs) {
    if (!article.isConnected) {
      softObserver.unobserve(article);
      recs.delete(article);
      rec.bar?.remove();
    }
  }
}

function mount(article: HTMLElement, id: string) {
  const post = extractPost(article, id);
  const me = ownHandle();
  const own = !!me && post.handle.toLowerCase() === me.toLowerCase();
  const rec: Rec = { id, article, post, skip: own || id === focalId(), view: "shown" };
  recs.set(article, rec);
  if (!own) attachSlot(rec);
  const known = memo.get(id);
  rec.features = known?.f;
  rec.ruleScores = known?.r;
  render(rec, "mount");
  if (!rec.features && !rec.skip) enqueue(rec);
}

function teardown(rec: Rec) {
  setView(rec, "shown");
  rec.slot?.remove();
  recs.delete(rec.article);
}

function resetAll() {
  for (const rec of recs.values()) teardown(rec);
  queue.length = 0;
}

function ensureDecor(rec: Rec) {
  if (rec.slot && !rec.slot.isConnected) attachSlot(rec);
  if (rec.view === "hidden" && settings.display === "collapse" && rec.bar && !rec.bar.isConnected)
    rec.article.before(rec.bar);
}

// ---------------------------------------------------------------------------
// Classification queue: nearest-to-viewport first, detached posts dropped
// ---------------------------------------------------------------------------

function enqueue(rec: Rec) {
  if (!configured) return;
  queue.push(rec);
  pump();
}

function distance(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  if (r.bottom > 0 && r.top < innerHeight) return 0;
  // Posts already scrolled past matter less than the ones coming up.
  return r.top >= innerHeight ? r.top - innerHeight : -r.bottom * 3;
}

function pump() {
  while (inFlight < MAX_IN_FLIGHT && queue.length) {
    let best = -1;
    let bestD = Infinity;
    for (let i = queue.length - 1; i >= 0; i--) {
      const r = queue[i];
      if (!r.article.isConnected || recs.get(r.article) !== r || (r.features && !r.stale)) {
        queue.splice(i, 1);
        if (best > i) best--;
        continue;
      }
      const d = distance(r.article);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return;
    const [rec] = queue.splice(best, 1);
    inFlight++;
    send<ClassifyResult>({ type: "classify", post: rec.post })
      .then((res) => {
        if (res?.features) {
          memo.set(rec.id, { f: res.features, r: res.rules });
          for (const r of recs.values()) {
            if (r.id !== rec.id || (r.features && !r.stale)) continue;
            r.features = res.features;
            r.ruleScores = res.rules;
            r.stale = false;
            render(r, "async");
          }
        } else if (res?.error === "not-configured") {
          configured = false;
          queue.length = 0;
        } else if (res?.error) {
          console.debug("[filterx]", res.error);
        }
      })
      .catch(() => {})
      .finally(() => {
        inFlight--;
        pump();
      });
  }
}

// ---------------------------------------------------------------------------
// Decisions and rendering
// ---------------------------------------------------------------------------

function scoreOf(rec: Rec): number | null {
  if (!rec.features) return null;
  const aff = affinity(learned.authors, rec.post.handle, rec.post.quote?.handle);
  return score(rec.features, learned.weights, aff, rec.ruleScores, rules);
}

function decide(rec: Rec): { hide: boolean; byUser: boolean; score: number | null } {
  const s = scoreOf(rec);
  if (rec.skip) return { hide: false, byUser: false, score: s };
  const vote = learned.votes[rec.id];
  if (vote) return { hide: vote === "hide", byUser: true, score: s };
  return { hide: s !== null && s >= settings.threshold, byUser: false, score: s };
}

function render(rec: Rec, cause: Cause) {
  const d = decide(rec);
  const why = d.byUser ? "you" : reasonText(rec);
  const vote = learned.votes[rec.id];

  if (rec.slot) {
    updateSlot(rec.slot, {
      vote,
      pending: !rec.features && !rec.skip && configured,
      filtered: d.hide && !d.byUser ? why : undefined,
      tooltip: tooltip(rec, d.score),
    });
  }

  if (!d.hide || revealed.has(rec.id)) {
    // Expanding a collapsed post above the reader would push the page down.
    if (rec.view === "hidden" && cause === "async" && positionOf(rec) === "above") return;
    return setView(rec, "shown");
  }
  if (rec.view === "hidden") return setView(rec, "hidden", why, d.byUser);
  // Only collapse where it can't move what the reader is looking at: below the
  // viewport, or on screen before first paint. Everything else dims instead.
  const pos = positionOf(rec);
  const collapse = cause === "user" || pos === "below" || (cause === "mount" && pos === "on");
  setView(rec, collapse ? "hidden" : "soft", why, d.byUser);

  if (!d.byUser && !reported.has(rec.id) && rec.features) {
    reported.add(rec.id);
    void send({
      type: "hidden",
      record: {
        id: rec.id,
        url: rec.post.url,
        handle: rec.post.handle,
        quoteHandle: rec.post.quote?.handle,
        summary: summarize(rec.post),
        reason: why,
        score: d.score ?? 1,
        features: rec.features,
        rules: rec.ruleScores,
        post: rec.post,
        ts: Date.now(),
      },
    });
  }
}

function setView(rec: Rec, view: View, why = "", byUser = false) {
  const { article } = rec;
  // Measure the avatar column while the post is still laid out, so the bar's
  // dot lines up with it whatever padding this X frontend uses.
  const avatarX = view === "hidden" && !rec.bar ? avatarCenterX(article) : null;
  rec.view = view;
  if (view === "shown") delete article.dataset.fxState;
  else article.dataset.fxState = view;

  const cell = cellOf(article);
  const remove = view === "hidden" && settings.display === "remove" && !byUser;
  if (cell) {
    if (remove) cell.dataset.fxRemoved = "1";
    else delete cell.dataset.fxRemoved;
  }

  if (view === "hidden" && !remove) {
    rec.bar ??= createBar((a) => onBar(rec, a));
    updateBar(rec.bar, byUser ? `Hidden by you · @${rec.post.handle}` : `${why} · @${rec.post.handle}`, byUser);
    if (rec.bar.nextElementSibling !== article) article.before(rec.bar);
    if (avatarX !== null) {
      const indent = Math.round(avatarX - rec.bar.getBoundingClientRect().left);
      if (indent >= 0 && indent < 120) rec.bar.style.setProperty("--fx-indent", `${indent}px`);
    }
  } else rec.bar?.remove();

  if (view === "soft") softObserver.observe(article);
  else softObserver.unobserve(article);
}

/** A dimmed post becomes a slim bar once it's scrolled out below the viewport
 *  (collapsing it above the reader would yank the page). */
const softObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) continue;
    const rec = recs.get(e.target as HTMLElement);
    if (rec?.view !== "soft") continue;
    if (e.boundingClientRect.top >= (e.rootBounds?.bottom ?? innerHeight)) {
      setView(rec, "hidden", reasonText(rec), false);
    }
  }
});

function avatarCenterX(article: HTMLElement): number | null {
  const img = article.querySelector('img[src*="profile_images"]');
  const box = (img?.closest("a") ?? img)?.getBoundingClientRect();
  return box?.width ? box.left + box.width / 2 : null;
}

function reasonText(rec: Rec) {
  return rec.features ? reason(rec.features, learned.weights, settings, rec.ruleScores, rules) : "";
}

/** Where the post's visible box (bar or article) sits relative to the viewport. */
function positionOf(rec: Rec): "above" | "on" | "below" {
  const el = rec.bar?.isConnected ? rec.bar : rec.article;
  const r = el.getBoundingClientRect();
  if (r.height === 0 && r.top === 0) return "on"; // display:none (removed); unknown
  if (r.top >= innerHeight) return "below";
  if (r.bottom <= 0) return "above";
  return "on";
}

function tooltip(rec: Rec, s: number | null): string | undefined {
  if (!rec.features) return undefined;
  const f = rec.features;
  const top = [
    ...CATEGORY_IDS.filter((c) => f[c] >= 0.2).map((c) => [CATEGORIES[c].label, f[c]] as const),
    ...activeRules(rules)
      .filter((r) => (rec.ruleScores?.[r.id] ?? 0) >= 0.2)
      .map((r) => [`${r.kind === "keep" ? "Keep: " : ""}${r.label}`, rec.ruleScores![r.id]] as const),
  ]
    .sort((a, b) => b[1] - a[1])
    .map(([label, p]) => `${label} ${pct(p)}`);
  return [
    `filterx score ${pct(s ?? 0)} (hides at ${pct(settings.threshold)})`,
    `Your taste ${pct(f.hide)} · Substance ${pct(f.substance)}`,
    ...(top.length ? [top.join(" · ")] : []),
  ].join("\n");
}
const pct = (x: number) => `${Math.round(x * 100)}%`;

function rerenderAll() {
  for (const rec of recs.values()) render(rec, "async");
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

function attachSlot(rec: Rec) {
  const anchor = voteAnchorOf(rec.article);
  if (!anchor) return;
  rec.slot ??= createSlot((label) => void onVote(rec, label));
  anchor.after(rec.slot);
}

async function onVote(rec: Rec, label: Label) {
  if (learned.votes[rec.id] === label) {
    delete learned.votes[rec.id];
    render(rec, "user");
    await send({ type: "unvote", id: rec.id });
    return;
  }
  if (label === "hide" && settings.syncNotInterested) await markNotInterested(rec.article).catch(() => false);
  learned.votes[rec.id] = label;
  if (label === "keep") revealed.add(rec.id);
  else revealed.delete(rec.id);
  render(rec, "user");
  await send({
    type: "vote",
    label,
    features: rec.features,
    rules: rec.ruleScores,
    post: rec.post,
  });
}

function onBar(rec: Rec, action: "show" | "keep" | "undo") {
  if (action === "show") {
    revealed.add(rec.id);
    render(rec, "user");
  } else if (action === "keep") void onVote(rec, "keep");
  else void onVote(rec, "hide"); // toggles the existing 👎 off
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function send<T = unknown>(msg: Message): Promise<T> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch {
    // Extension reloaded while the tab stayed open; this content script is orphaned.
    return undefined as T;
  }
}

function applyTheme() {
  const t = detectTheme();
  if (document.documentElement.dataset.fxTheme !== t) document.documentElement.dataset.fxTheme = t;
}

async function init() {
  settings = await loadSettings();
  learned = await loadLearned(settings);
  rules = await loadRules();
  version = featureVersion(settings, rules);

  /** The questions changed meaning (settings or rules); old probabilities are stale. */
  const revalidate = () => {
    const v = featureVersion(settings, rules);
    if (v === version) return;
    version = v;
    memo.clear();
    for (const rec of recs.values()) {
      rec.stale = true;
      enqueue(rec);
    }
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) {
      settings = mergeSettings(changes.settings.newValue as Partial<Settings>);
      configured = true;
      revalidate();
      if (!settings.enabled) resetAll();
      else {
        rerenderAll();
        schedule();
      }
    }
    if (changes.rules) {
      rules = (changes.rules.newValue as Rule[] | undefined) ?? [];
      revalidate();
    }
    if (changes.learned?.newValue) {
      learned = changes.learned.newValue as Learned;
      rerenderAll();
    }
  });

  applyTheme();
  new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ["style"] });
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
}

void init();
