# filterx

A Chrome extension that quietly filters your X feed (politics, rage bait, provocation, engagement farming, low-value filler, brand promo) using Cloudflare's **Clef** decision model, personalized by your 👍 / 👎.

```
extension/   MV3 extension (TypeScript, built with Bun)
worker/      Cloudflare Worker proxy (keeps your CF token out of the browser)
scripts/     smoke.ts: labelled posts → Clef → verdicts
```

## How it decides

1. **Clef** (`@cf/cloudflare/clef`, 27B, one forward pass, ~$0.35 per 1,000 posts) gets the post as structured state (author, text, quoted post, link card, engagement, up to 4 downscaled images/video thumbnails) and answers 9 yes/no questions at once: one per category, plus *substance* (counts toward keeping) and *personal*. The personal question includes your taste notes and the 5 + 5 past votes most similar to the post.
2. **A local logistic layer** combines those probabilities with author affinity into one score. Starting weights are hand-set; every vote refits it in milliseconds (regularized toward the starting weights; wrongly hiding a post is penalized 1.4× more than wrongly showing one). Re-scoring needs no network call, so a vote reflows every post on screen right away.
3. A post is hidden when its score is at or above the sensitivity threshold (Relaxed 0.85 / Balanced 0.70 / Strict 0.55).

### Self-learning: votes → rules → Clef questions

Your full vote history is never sent with each request. It's used in a periodic **learning pass** (automatic every 25 new votes, or *Learn from my votes* in settings):

1. **Propose.** `gpt-oss-120b` on Workers AI reads your votes. It starts with the ones the current filter got wrong, and drafts plain-language hide/keep rules, each with a yes/no question ("Does the post promote speculative crypto … using hype language or price forecasts?").
2. **Test.** Clef answers every candidate question on up to 300 of your past voted posts, all in one call per post. Votes store the full post, so new rules can be checked against old votes.
3. **Adopt.** A rule survives only if it matches at least 3 votes on its own side and at most 20% on the other, and if adding it doesn't increase 5-fold held-out mistakes (wrong hides cost 1.4×). Learned rules that stop matching your votes are retired.

Adopted rules become extra Clef questions on every post (≈30 tokens each) and are listed in the personal question as directions. The local layer learns a weight for each. In settings, every rule shows what it matched in your votes ("6/15 of your 👎 · 0/26 of your 👍"), and you can turn it off (it won't be proposed again), delete it, or add your own.

`bun scripts/learn-smoke.ts` runs the loop on a synthetic voter. It recovers the planted crypto-hype and hustle-advice hide rules plus AI-policy and engineering keep rules, taking held-out mistakes from 3.7% to 0%.

`bun scripts/smoke.ts` runs 11 labelled posts (political, brand promo, rage bait, ratio filler, and five should-keep posts) through Clef and prints per-question probabilities and verdicts. Two cases use screenshots from `scripts/fixtures/` (gitignored); without them they run text-only. Clef Flash misses the political case in my runs, so Clef is the default.

## UX

- **Classified before you see it.** Posts are queued as soon as X renders them, nearest to the viewport first, 6 in flight. Known verdicts apply in the same frame the post mounts, before paint, so nothing jumps.
- **No layout shift under the reader.** Layout only ever changes below the viewport. A verdict for a post on screen or above it dims the post to 30% (hover to read) with a small reason chip. It collapses once it's below you, and a hidden post above you is never expanded behind your back. When rules change, the old verdicts stay until the new ones arrive.
- **Hidden posts** become a slim 36px line ("Promo · @northwindmotors") with *Show* and 👍 on hover, or are removed entirely (popup toggle).
- **👍 👎 next to the timestamp**, visible on hover. Hovering the buttons shows a tooltip with every probability.
- **Popup → "Recently hidden"**, a safety net against over-capture: one click to 👍 anything that should have stayed.
- Never filters: the post you clicked into, your own posts, notifications, DMs, bookmarks, lists.
- Fails open: errors or no connection mean nothing gets hidden.

## Setup

```sh
# 1. Worker (recommended)
cd worker && bun install
bunx wrangler secret put FILTERX_SECRET   # any long random string
bunx wrangler deploy

# 2. Extension
cd ../extension && bun install && bun run build    # or: bun run dev (watch)
```

Load `extension/dist` via `chrome://extensions` → Developer mode → *Load unpacked*. The options page opens on install. Paste the Worker URL and secret, then hit **Test connection**.

Alternatively choose **Direct API** and paste an account ID and a Workers AI API token. It's simpler, but the token then lives in the browser profile.

## Notes and edge cases

- **Two X frontends.** X currently serves a classic React DOM (`data-testid`) and a newer Base UI/"xds" DOM (no test ids). `content/dom.ts` relies on structure both share. Extraction was verified live against the new DOM; the classic selectors follow X's long-standing test ids. If X changes markup, `dom.ts` is the only file to fix.
- **Images.** Workers AI estimates image tokens from base64 size, so full-size images overflow Clef's 64k context. The service worker downscales to 512px JPEG (≈250 real tokens each) under a total budget.
- **Videos/GIFs** use their poster frame. **Quote posts** send both posts, with quote media tagged separately. **Promoted posts** without a permalink are keyed by a content hash.
- **"Not interested" sync** (off by default) drives X's own ⋯ menu invisibly on 👎. It matches English labels only.
- Verdicts are cached per post (4,000 entries). Changing categories, taste notes, model, or image analysis invalidates the cache, since the questions changed.

## License

MIT
