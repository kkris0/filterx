import { hash } from "../shared/model";
import type { PostData, PostMedia } from "../shared/types";

/**
 * Everything that knows about X's DOM lives here.
 *
 * X currently ships two web frontends: the classic React app (data-testid
 * everywhere) and a newer Base UI/"xds" app (no test ids, Tailwind classes).
 * We lean on structure both share (status links, @handle spans, pbs.twimg.com
 * media paths, dir="auto" text) and use test ids only as a preference.
 */

export const ARTICLE_SELECTOR = "article";

const STATUS_HREF = /^\/\w+\/status\/(\d+)\/?$/;
const HANDLE = /^@\w{1,15}$/;

/** The element to remove entirely in "remove" mode. */
export function cellOf(article: HTMLElement): HTMLElement | null {
  return article.closest<HTMLElement>('[data-testid="cellInnerDiv"], li');
}

/** True for <article>s that are posts we should look at (not nested inside another one). */
export function isPostArticle(article: HTMLElement): boolean {
  return !article.parentElement?.closest("article");
}

/** The embedded quote block, if any: a role=link container inside the post with its own @handle. */
export function quoteOf(article: HTMLElement): HTMLElement | null {
  for (const el of article.querySelectorAll<HTMLElement>('div[role="link"], [data-testid="quoteTweet"]')) {
    if (el.querySelector('[data-testid="User-Name"]') || [...el.querySelectorAll("span")].some((s) => HANDLE.test(s.textContent ?? "")))
      return el;
  }
  return null;
}

const outside = (quote: HTMLElement | null) => (el: Element) => !quote || !quote.contains(el);

/** The main post's permalink anchor (the one showing its timestamp). */
export function timeLinkOf(article: HTMLElement, quote = quoteOf(article)): HTMLAnchorElement | null {
  const out = outside(quote);
  for (const t of article.querySelectorAll("time")) {
    const a = t.closest<HTMLAnchorElement>('a[href*="/status/"]');
    if (a && out(a)) return a;
  }
  for (const a of article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')) {
    if (out(a) && STATUS_HREF.test(a.getAttribute("href") ?? "")) return a;
  }
  return null;
}

export function postIdOf(article: HTMLElement): string | null {
  const href =
    timeLinkOf(article)?.getAttribute("href") ??
    article.closest("[data-href]")?.getAttribute("data-href") ??
    "";
  const m = href.match(/\/status\/(\d+)/);
  if (m) return m[1];
  // Promoted posts have no permalink; key them by content instead.
  const text = mainTextEl(article, quoteOf(article))?.textContent;
  return text ? `h${hash(text)}` : null;
}

function author(scope: Element, quote: HTMLElement | null) {
  const out = outside(quote);
  const userName = [...scope.querySelectorAll('[data-testid="User-Name"]')].find(out);
  const root = userName ?? scope;
  const handleSpan = [...root.querySelectorAll("span")].find((s) => out(s) && HANDLE.test(s.textContent ?? ""));
  const handle = handleSpan?.textContent?.slice(1) ?? "";
  let name = "";
  for (const a of root.querySelectorAll<HTMLAnchorElement>(`a[href="/${handle}" i]`)) {
    const t = a.textContent?.trim() ?? "";
    if (out(a) && t && !t.startsWith("@")) {
      name = t;
      break;
    }
  }
  const verified = !!root.querySelector('[data-testid="icon-verified"], [aria-label="Verified account"]');
  return { name: name || handle, handle, verified };
}

function mainTextEl(article: HTMLElement, quote: HTMLElement | null): Element | undefined {
  const out = outside(quote);
  const byId = [...article.querySelectorAll('[data-testid="tweetText"]')].find(out);
  if (byId) return byId;
  // Classic DOM without tweetText means a media-only post; don't guess.
  if (article.querySelector("[data-testid]")) return undefined;
  return [...article.querySelectorAll('div[dir="auto"]')].find((d) => out(d) && !d.closest("a"));
}

function textOf(el: Element | null | undefined): string {
  if (!el) return "";
  // Emoji render as <img alt>, so stitch them back in.
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
    else if (n instanceof HTMLImageElement) out += n.alt;
    else if (n instanceof HTMLElement && n.tagName === "BR") out += "\n";
    else n.childNodes.forEach(walk);
  };
  walk(el);
  return out.trim();
}

export function pageKind(): PostData["page"] {
  const p = location.pathname;
  if (p === "/home" || p === "/") return "home";
  if (/\/status\/\d+/.test(p)) return "thread";
  if (p.startsWith("/search") || p.startsWith("/explore")) return "search";
  if (/^\/\w+\/?$/.test(p) || /^\/\w+\/(with_replies|media|highlights)/.test(p)) return "profile";
  return "other";
}

/** Pages where filtering would be wrong: your own stuff, DMs, notifications, bookmarks. */
export function pageIsExcluded(): boolean {
  const p = location.pathname;
  if (/^\/(notifications|messages|settings|compose|i\/bookmarks|i\/lists|i\/chat)/.test(p)) return true;
  const me = ownHandle();
  return !!me && new RegExp(`^/${me}(/|$)`, "i").test(p);
}

let cachedOwn: string | null = null;
export function ownHandle(): string | null {
  if (cachedOwn) return cachedOwn;
  const href = document
    .querySelector<HTMLAnchorElement>('a[data-testid="AppTabBar_Profile_Link"], nav a[aria-label="Profile"]')
    ?.getAttribute("href");
  cachedOwn = href ? href.replace(/^\//, "") : null;
  return cachedOwn;
}

/** The post a /status/ page is about. Never filter it; you clicked into it. */
export function focalId(): string | null {
  return location.pathname.match(/\/status\/(\d+)/)?.[1] ?? null;
}

const MEDIA_KIND: [RegExp, PostMedia["kind"]][] = [
  [/\/(ext_tw_video_thumb|amplify_video_thumb)\//, "video"],
  [/\/tweet_video_thumb\//, "gif"],
  [/\/card_img\//, "card"],
  [/\/media\//, "photo"],
];

function collectMedia(article: HTMLElement, quote: HTMLElement | null): PostMedia[] {
  const media: PostMedia[] = [];
  const seen = new Set<string>();
  const add = (kind: PostMedia["kind"], url: string, el: Element, alt?: string) => {
    const key = url.split("?")[0];
    if (!url || seen.has(key)) return;
    seen.add(key);
    media.push({ kind, url, alt: alt && alt !== "Image" ? alt : undefined, inQuote: !!quote?.contains(el) });
  };
  // Video posters first so the same frame isn't also counted as a photo.
  for (const v of article.querySelectorAll<HTMLVideoElement>("video[poster]")) {
    add(/tweet_video/.test(v.poster + v.src) ? "gif" : "video", v.poster, v);
  }
  for (const img of article.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com"]')) {
    let kind = MEDIA_KIND.find(([re]) => re.test(img.src))?.[1];
    if (kind === "photo" && /video|gif/i.test(img.alt)) kind = /gif/i.test(img.alt) ? "gif" : "video";
    if (kind) add(kind, img.src, img, kind === "photo" ? img.alt : undefined);
  }
  return media;
}

function engagementOf(article: HTMLElement, quote: HTMLElement | null): string | undefined {
  const out = outside(quote);
  const group = [...article.querySelectorAll('[role="group"][aria-label]')].find(out);
  if (group) return group.getAttribute("aria-label") ?? undefined;
  const parts = [...article.querySelectorAll<HTMLElement>("[data-engagement-action]")]
    .filter(out)
    .map((e) => [e.dataset.engagementAction === "generic" ? "views" : e.dataset.engagementAction, e.textContent?.trim()])
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${k}`);
  return parts.length ? parts.join(", ") : undefined;
}

export function extractPost(article: HTMLElement, id: string): PostData {
  const quote = quoteOf(article);
  const card = article.querySelector('[data-testid="card.wrapper"]') ?? article.querySelector('a[href^="https://t.co/"] img[src*="card_img"]')?.closest("a")?.parentElement;
  const quoteAuthor = quote ? author(quote, null) : null;
  return {
    id,
    url: timeLinkOf(article, quote)?.href ?? location.href,
    ...author(article, quote),
    text: textOf(mainTextEl(article, quote)),
    context: article.querySelector('[data-testid="socialContext"]')?.textContent?.trim() || undefined,
    page: pageKind(),
    quote: quote && quoteAuthor ? { ...quoteAuthor, text: textOf(mainTextEl(quote, null)) } : undefined,
    card: card && outside(quote)(card) ? clip(card.textContent ?? "", 300) || undefined : undefined,
    poll: clip(article.querySelector('[data-testid="cardPoll"]')?.textContent ?? "", 300) || undefined,
    media: collectMedia(article, quote),
    engagement: engagementOf(article, quote),
  };
}

function clip(s: string, n: number) {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Where the vote buttons go: right after the timestamp, as in the mock. */
export function voteAnchorOf(article: HTMLElement): HTMLElement | null {
  return timeLinkOf(article)?.parentElement ?? null;
}

/** X's own "⋯" menu button on the post. */
export function moreButtonOf(article: HTMLElement): HTMLElement | null {
  const quote = quoteOf(article);
  return (
    [...article.querySelectorAll<HTMLElement>('[data-testid="caret"], button[aria-label="More"]')].find(outside(quote)) ?? null
  );
}

export type Theme = "light" | "dim" | "dark";
export function detectTheme(): Theme {
  const bg = getComputedStyle(document.body).backgroundColor;
  const m = bg.match(/\d+/g)?.map(Number);
  if (!m) return "dark";
  const [r, g, b] = m;
  if (r + g + b > 600) return "light";
  if (r === 0 && g === 0 && b === 0) return "dark";
  return "dim";
}
