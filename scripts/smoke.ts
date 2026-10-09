/**
 * Runs labelled sample posts through Clef with the exact questions the
 * extension sends, and prints per-question probabilities and the final score.
 *
 *   bun scripts/smoke.ts [--flash] [--no-images]
 *
 * Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN from .env (Bun loads it).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildQuestions, defaultWeights, postState, reason, score } from "../extension/src/shared/model";
import { DEFAULT_SETTINGS } from "../extension/src/shared/settings";
import { FEATURE_KEYS, type Features, type PostData } from "../extension/src/shared/types";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_AUTH_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN in .env");

const flash = process.argv.includes("--flash");
const useImages = !process.argv.includes("--no-images");
const settings = { ...DEFAULT_SETTINGS, model: flash ? ("clef-flash" as const) : ("clef" as const) };

// Fixture screenshots are not committed (gitignored). Image cases run text-only without them.
const hasFixture = (name: string) => existsSync(join(import.meta.dir, "fixtures", name));
const fixture = (name: string) =>
  `data:image/jpeg;base64,${readFileSync(join(import.meta.dir, "fixtures", name)).toString("base64")}`;

const base = { url: "", verified: false, page: "home" as const, media: [] };
const cases: { expect: "hide" | "keep"; post: PostData; images?: string[] }[] = [
  {
    expect: "hide",
    post: {
      ...base,
      id: "brand",
      name: "fern",
      handle: "quietfern",
      text: "Unintroduce it 😭",
      quote: {
        name: "Northwind Motors",
        handle: "northwindmotors",
        text: "Strikingly vibrant.\n\nIntroducing THE NEW Northwind X4.\n\n#NorthwindX4 #Northwind #NewEra #NorthwindGroup",
      },
      media: [{ kind: "photo", url: "", inQuote: true }, { kind: "photo", url: "", inQuote: true }],
      engagement: "38 replies, 178 reposts, 5100 likes, 99000 views",
    },
    images: ["brand-quote.jpg"],
  },
  {
    expect: "hide",
    post: {
      ...base,
      id: "lex",
      name: "Jay",
      handle: "jaywalker_42",
      text: "The...comics?",
      quote: { name: "ComicFan", handle: "comicfan_", text: "Who gave us the most accurate Lex Luthor?" },
      media: [{ kind: "photo", url: "", alt: "Comics / Superman / Snyderverse Lex Luthor comparison", inQuote: true }],
      engagement: "32 replies, 712 reposts, 27000 likes, 263000 views",
    },
    images: ["lex-luthor.jpg"],
  },
  {
    expect: "hide",
    post: {
      ...base,
      id: "h1b",
      name: "Lens",
      handle: "lens_on_work",
      verified: true,
      text: "I worked at Microsoft for 20 years. This is exactly why they hired H1-B workers. It was not a secret, at least not in the Finance org where it was openly discussed. H1-B workers cost less and drove down development wages.",
      quote: {
        name: "Civic Office",
        handle: "civicoffice",
        text: "Corporations are laying off American workers and replacing them with H-1B Visa labor, undercutting the wages of American workers. This system has been going on for years.",
      },
      media: [{ kind: "video", url: "", inQuote: true }],
      engagement: "65 replies, 1000 reposts, 5400 likes, 90000 views",
    },
  },
  {
    expect: "keep",
    post: {
      ...base,
      id: "pg",
      name: "Dana B.",
      handle: "dbnerd",
      text: "We cut p99 query latency on our largest Postgres cluster from 140ms to 11ms. The fix wasn't an index — it was moving hot rows out of a table with 400GB of dead tuples and switching autovacuum to per-table thresholds. Writeup with graphs below.",
      card: "How we fixed autovacuum at scale — example-db.dev",
    },
  },
  {
    expect: "keep",
    post: {
      ...base,
      id: "release",
      name: "FastJS",
      handle: "fastjs",
      verified: true,
      text: "FastJS v1.3 is out: built-in Redis client, SQL for MySQL & SQLite, a 3x faster install on Windows, and full-stack dev server with HMR. Upgrade with `fastjs upgrade`.",
    },
  },
  {
    expect: "keep",
    post: {
      ...base,
      id: "joke",
      name: "Sys",
      handle: "sysjoker",
      text: "Every distributed systems talk is just someone discovering a new way two computers can disagree about what time it is.",
    },
  },
  {
    expect: "keep",
    post: {
      ...base,
      id: "science",
      name: "Math Digest",
      handle: "mathdigest",
      verified: true,
      text: "Mathematicians have proved that a simple process for building random networks almost always produces graphs with a perfect matching, settling a conjecture that has stood since the 1960s.",
      card: "New Proof Settles Decades-Old Conjecture About Random Graphs — example.org",
    },
  },
  {
    expect: "hide",
    post: {
      ...base,
      id: "jsbait",
      name: "dev guru",
      handle: "10xthoughts",
      verified: true,
      text: "If you still write JavaScript in 2026 you are not a real engineer. Sorry not sorry. Fight me 👇",
      engagement: "1200 replies, 90 reposts, 800 likes, 400000 views",
    },
  },
  {
    expect: "hide",
    post: {
      ...base,
      id: "ratio",
      name: "kai",
      handle: "kaiposts",
      text: "ratio + L + nobody asked 💀💀",
      quote: { name: "Some Guy", handle: "someguy", text: "Hot dogs are sandwiches and I will die on this hill" },
    },
  },
  {
    expect: "keep",
    post: {
      ...base,
      id: "indie",
      name: "Sam Indie",
      handle: "indiedev_sam",
      text: "After 3 years of nights and weekends I finally shipped my game. Wrote a short postmortem on what I'd do differently: scope, tooling, and why I rewrote the renderer twice.",
      media: [{ kind: "photo", url: "", alt: "Screenshot of a pixel-art game", inQuote: false }],
    },
  },
  {
    expect: "keep",
    post: {
      ...base,
      id: "aiact",
      name: "Lena Notes",
      handle: "localllm_notes",
      verified: true,
      text: "Notes on running the new open-weights 27B model locally: 4-bit quant fits in 18GB, ~40 tok/s on an M4 Max, and the tool-calling format is compatible with the OpenAI spec. Benchmarks and gotchas in the post.",
    },
  },
];

const w = defaultWeights(settings);
console.log(`model=${settings.model} images=${useImages}\n`);

let correct = 0;
const results = await Promise.all(
  cases.map(async (c) => {
    const body: Record<string, unknown> = {
      model: settings.model,
      state: postState(c.post),
      questions: buildQuestions(settings, [], []),
    };
    const images = (c.images ?? []).filter(hasFixture);
    if (useImages && images.length) body.images = images.map(fixture);
    const t0 = performance.now();
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${settings.model}`,
      { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    const ms = Math.round(performance.now() - t0);
    const json = (await res.json()) as any;
    if (!res.ok || !json.success) return { c, ms, error: JSON.stringify(json.errors ?? json).slice(0, 400) };
    const f = {} as Features;
    for (const k of FEATURE_KEYS) f[k] = json.result.answers[k]?.noul ?? 0;
    return { c, ms, f, usage: json.result.usage };
  }),
);

for (const r of results) {
  if ("error" in r) {
    console.log(`✗ ${r.c.post.id}: ${r.error}\n`);
    continue;
  }
  const s = score(r.f!, w, 0);
  const verdict = s >= settings.threshold ? "hide" : "keep";
  if (verdict === r.c.expect) correct++;
  console.log(
    `${verdict === r.c.expect ? "✓" : "✗"} ${r.c.post.id.padEnd(8)} expect=${r.c.expect} got=${verdict} score=${s.toFixed(2)} reason=${verdict === "hide" ? reason(r.f!, w, settings) : "-"}  ${r.ms}ms  in=${r.usage?.input_tokens}`,
  );
  console.log("   " + FEATURE_KEYS.map((k) => `${k}=${r.f![k].toFixed(2)}`).join(" "));
}
console.log(`\n${correct}/${cases.length} correct`);
