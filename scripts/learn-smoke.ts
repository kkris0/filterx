/**
 * End-to-end test of the rule-learning loop with a synthetic voter whose taste
 * the built-in categories don't fully cover:
 *   hide: crypto price shilling, hustle-guru threads (+ some ordinary noise)
 *   keep: AI / tech regulation news (touches "politics", but they want it), technical posts
 *
 *   bun scripts/learn-smoke.ts
 *
 * Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN from .env.
 */
import { learnRules } from "../extension/src/shared/learn";
import { buildQuestions, crossValidatedCost, fit, postState, summarize } from "../extension/src/shared/model";
import { DEFAULT_SETTINGS } from "../extension/src/shared/settings";
import { FEATURE_KEYS, type Example, type Features, type Label, type PostData } from "../extension/src/shared/types";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_AUTH_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN in .env");
const settings = { ...DEFAULT_SETTINGS };

async function run(model: string, body: unknown) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (!res.ok || !json.success) throw new Error(JSON.stringify(json.errors ?? json).slice(0, 300));
  return json.result;
}

const V: [Label, string, string][] = [
  ["hide", "cryptokingz", "$PEPE about to 50x. Bags loaded, charts don't lie. NFA but you'll regret fading this 🚀🚀"],
  ["hide", "altcoinsherpa", "ETH/BTC ratio bottomed. Altseason confirmed. Rotate into low caps NOW before the 100x run."],
  ["hide", "moonboy", "Just aped 20k into a new AI token on Base. Dev is based. Get in early or cry later."],
  ["hide", "chartwizard", "Bitcoin to 250k by Christmas. Anyone selling here is ngmi. Laser eyes on 🔴"],
  ["hide", "solsignals", "SOL breakout imminent. 3 coins I'm buying this week (thread) 🧵👇"],
  ["hide", "grindset", "I wake up at 4:30am, cold plunge, 2 hours of deep work before you've opened your eyes. That's why you're broke."],
  ["hide", "ceo_mindset", "10 habits of millionaires nobody tells you about (thread) 🧵 1. They never take weekends off."],
  ["hide", "hustleacademy", "Your 9-5 is a prison. I quit mine at 24 and now make 50k/month. Here's the exact playbook 👇"],
  ["hide", "alpha_male_ceo", "Stop scrolling. 99% of people will never be successful because they lack discipline. Be the 1%."],
  ["hide", "growthguru", "I read 100 books last year. Here are the 7 that made me a millionaire (number 4 will shock you) 🧵"],
  ["hide", "popbase", "Taylor Swift and Travis Kelce spotted at dinner in NYC tonight 👀"],
  ["hide", "dcu_updates", "Who wore the cape better? Henry Cavill vs David Corenswet 👇"],
  ["hide", "ragepolitics", "These people want to destroy everything you love. Share if you agree. 😡"],
  ["keep", "techpolicy", "The EU AI Act's obligations for general-purpose models take effect today. Here's what changes for open-weights releases and who must publish training-data summaries."],
  ["keep", "lawblog", "New analysis: how the US export controls on AI chips are being enforced, and the loopholes cloud providers are exploiting."],
  ["keep", "techwire", "The FTC is suing over dark patterns in subscription cancellation flows; the complaint details 14 specific UI tricks."],
  ["keep", "digitalrights", "California passed a bill requiring disclosure when content is AI-generated. We break down what it means for platforms and open-source models."],
  ["keep", "edgedev", "We cut cold starts on our edge runtime by 60% by snapshotting the V8 isolate after module init. Writeup with flamegraphs."],
  ["keep", "localllm_notes", "Notes on running the new 27B open-weights model locally: 4-bit quant fits in 18GB, ~40 tok/s on an M4 Max."],
  ["keep", "reactfan", "A pattern I keep reaching for in React: colocate state with the component that owns the URL. Short post with examples."],
  ["keep", "webplatformer", "TIL: the View Transitions API now works cross-document in all major browsers. Demo + gotchas."],
  ["keep", "mathdigest", "Mathematicians proved a decades-old conjecture about random graphs having perfect matchings."],
  ["keep", "opsveteran", "Postmortem: our storage cluster lost quorum for 9 minutes. Root cause was a clock skew bug in our lease logic."],
  ["keep", "dbhosting", "How we migrated 3PB from MySQL 5.7 to 8.0 with zero downtime, including the replication edge cases we hit."],
  ["keep", "sysjoker", "Every distributed systems talk is just someone discovering a new way two computers can disagree about what time it is."],
  ["hide", "nftwhale", "Floor price on my collection just doubled. Still time to mint before reveal. Link in bio 🔥"],
  ["hide", "mindsetdaily", "Rich people think differently. Poor people watch Netflix. Which one are you?"],
];

console.log(`Classifying ${V.length} synthetic votes with the base questions…`);
const examples: Example[] = await Promise.all(
  V.map(async ([label, handle, text], i) => {
    const post: PostData = { id: `v${i}`, url: "", name: handle, handle, verified: false, text, page: "home", media: [] };
    const out = await run("@cf/cloudflare/clef", { model: "clef", state: postState(post), questions: buildQuestions(settings, [], []) });
    const features = {} as Features;
    for (const k of FEATURE_KEYS) features[k] = out.answers[k]?.noul ?? 0;
    return { id: post.id, label, summary: summarize(post), handle, post, features, rules: {}, ts: i };
  }),
);

const before = crossValidatedCost(examples, settings, []);
const t0 = performance.now();
const result = await learnRules(
  { examples, rules: [], settings },
  {
    clef: (body) => run("@cf/cloudflare/clef", { ...body, model: "clef" }),
    writer: async (messages, schema) => {
      const out = await run("@cf/openai/gpt-oss-120b", {
        messages,
        reasoning_effort: "medium",
        max_completion_tokens: 6000,
        response_format: { type: "json_schema", json_schema: { name: "output", strict: true, schema } },
      });
      return JSON.parse(out.choices[0].message.content);
    },
    progress: (m) => console.log("  …", m),
  },
);
console.log(`\nLearned in ${Math.round((performance.now() - t0) / 1000)}s`);
console.log(result.report);
for (const r of result.rules) {
  console.log(`\n[${r.kind}] ${r.label}\n  ${r.text}\n  Q: ${r.question}\n  matched ${r.stats?.hide}/${r.stats?.ofHide} 👎, ${r.stats?.keep}/${r.stats?.ofKeep} 👍`);
}

// Same votes, before vs after, with the rules' scores merged in.
const merged = examples.map((e) => ({ ...e, rules: result.ruleScores[e.id] ?? {} }));
const learned = fit(merged, settings, result.rules);
console.log(`\nCV cost before rules: ${before.toFixed(3)}  after: ${crossValidatedCost(merged, settings, result.rules).toFixed(3)}`);
console.log("rule weights:", Object.fromEntries(Object.entries(learned.weights).filter(([k]) => k.startsWith("rule:")).map(([k, v]) => [k, +v.toFixed(2)])));
