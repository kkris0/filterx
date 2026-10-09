import { icon } from "./shared/icons";
import { MIN_VOTES } from "./shared/learn";
import { CATEGORIES } from "./shared/model";
import { loadRules, loadSettings, saveSettings } from "./shared/settings";
import { CATEGORY_IDS, type ClassifyResult, type Example, type LearnState, type Rule, type Settings } from "./shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;

let savedTimer: ReturnType<typeof setTimeout> | undefined;
async function save(patch: Partial<Settings>) {
  settings = await saveSettings(patch);
  const el = $("saved");
  el.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove("show"), 1_200);
  paint();
}

function seg(id: string, value: string, onPick: (v: string) => void) {
  for (const b of $(id).querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.v === value));
    b.onclick = () => onPick(b.dataset.v!);
  }
}

function paint() {
  $<HTMLInputElement>("enabled").checked = settings.enabled;
  seg("mode", settings.connection.mode, (mode) =>
    save({ connection: { ...settings.connection, mode: mode as Settings["connection"]["mode"] } }),
  );
  $("worker-fields").hidden = settings.connection.mode !== "worker";
  $("direct-fields").hidden = settings.connection.mode !== "direct";
  seg("model", settings.model, (model) => save({ model: model as Settings["model"] }));
  $<HTMLInputElement>("analyzeImages").checked = settings.analyzeImages;
  $<HTMLInputElement>("autoLearn").checked = settings.autoLearn;
  $<HTMLInputElement>("syncNotInterested").checked = settings.syncNotInterested;

  $("categories").replaceChildren(
    ...CATEGORY_IDS.map((c) => {
      const row = document.createElement("div");
      row.className = "toggle-row";
      const text = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = CATEGORIES[c].label;
      const small = document.createElement("small");
      small.textContent = CATEGORIES[c].description;
      text.append(b, small);
      const sw = document.createElement("label");
      sw.className = "switch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = settings.categories[c];
      input.onchange = () => save({ categories: { ...settings.categories, [c]: input.checked } });
      sw.append(input);
      row.append(text, sw);
      return row;
    }),
  );
}

function bindText(id: string, read: () => string, write: (v: string) => Partial<Settings>) {
  const el = $<HTMLInputElement | HTMLTextAreaElement>(id);
  el.value = read();
  el.onchange = () => void save(write(el.value.trim()));
}

async function paintVotes() {
  const { examples = [] } = (await chrome.storage.local.get("examples")) as { examples?: Example[] };
  const hides = examples.filter((e) => e.label === "hide").length;
  $("learn-summary").textContent = examples.length
    ? `${examples.length} votes (${hides} 👎, ${examples.length - hides} 👍). Each one refits your personal layer instantly and becomes a few-shot example for similar posts.`
    : "No votes yet. Use 👍 / 👎 next to a post's timestamp on X.";
  const list = $("votes");
  list.hidden = !examples.length;
  list.replaceChildren(
    ...examples
      .slice()
      .reverse()
      .slice(0, 50)
      .map((e) => {
        const row = document.createElement("div");
        row.className = "vote";
        const chip = document.createElement("span");
        chip.className = `chip ${e.label}`;
        chip.textContent = e.label === "hide" ? "hide" : "keep";
        const text = document.createElement("span");
        text.className = "vote-text";
        text.textContent = e.summary;
        text.title = e.summary;
        const del = document.createElement("button");
        del.className = "icon-btn";
        del.title = "Forget this vote";
        del.append(icon("x"));
        del.onclick = async () => {
          await chrome.storage.local.set({ examples: examples.filter((x) => x.id !== e.id) });
        };
        row.append(chip, text, del);
        return row;
      }),
  );
}

// ---------------------------------------------------------------------------
// Learned rules
// ---------------------------------------------------------------------------

let newKind: Rule["kind"] = "hide";

async function paintRules() {
  const [rules, { learn, examples = [] }] = await Promise.all([
    loadRules(),
    chrome.storage.local.get(["learn", "examples"]) as Promise<{ learn?: LearnState; examples?: Example[] }>,
  ]);
  const status = $("learn-status");
  const btn = $<HTMLButtonElement>("learn-now");
  btn.hidden = learn?.status === "running";
  status.className = learn?.status === "running" ? "running" : learn?.status === "error" ? "err" : "";
  status.textContent =
    learn?.status === "running"
      ? (learn.message ?? "Learning…")
      : learn?.status === "error"
        ? (learn.message ?? "Learning failed")
        : learn?.report
          ? summary(learn)
          : examples.length < MIN_VOTES
            ? `Learns once you have ${MIN_VOTES} votes (you have ${examples.length}).`
            : `Ready to learn from ${examples.length} votes.`;

  const list = $("rules");
  list.hidden = !rules.length;
  list.replaceChildren(...rules.map((r) => ruleRow(r, rules)));
  seg("new-kind", newKind, (v) => {
    newKind = v as Rule["kind"];
    void paintRules();
  });
}

function summary(l: LearnState): string {
  const r = l.report!;
  const parts = [`Learned ${ago(l.at!)} from ${r.votes} votes.`];
  if (r.added.length) parts.push(`Added ${r.added.map((x) => `“${x}”`).join(", ")}.`);
  if (r.retired.length) parts.push(`Retired ${r.retired.map((x) => `“${x}”`).join(", ")}.`);
  if (!r.added.length && !r.retired.length) parts.push(r.proposed ? `Tested ${r.proposed} new ideas; none beat the current rules.` : "No new patterns.");
  parts.push(`Held-out mistakes: ${pct(r.errorBefore)} → ${pct(r.errorAfter)}.`);
  return parts.join(" ");
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function ruleRow(r: Rule, all: Rule[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "rule" + (r.enabled ? "" : " off");
  const chip = document.createElement("span");
  chip.className = `chip ${r.kind}`;
  chip.textContent = r.kind;
  const body = document.createElement("div");
  const b = document.createElement("b");
  b.textContent = r.label;
  const text = document.createElement("div");
  text.className = "rule-text";
  text.textContent = r.text;
  text.title = `Clef is asked: ${r.question}`;
  const meta = document.createElement("div");
  meta.className = "rule-meta";
  const st = r.stats;
  meta.textContent = [
    r.source === "user" ? "yours" : "learned",
    st ? `matched ${st.hide}/${st.ofHide} of your 👎 · ${st.keep}/${st.ofKeep} of your 👍` : "not tested yet",
  ].join(" · ");
  body.append(b, text, meta);

  const sw = document.createElement("label");
  sw.className = "switch";
  sw.title = r.enabled ? "Turn off (it won't be proposed again)" : "Turn on";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = r.enabled;
  input.onchange = () => saveRules(all.map((x) => (x.id === r.id ? { ...x, enabled: input.checked } : x)));
  sw.append(input);

  const del = document.createElement("button");
  del.className = "icon-btn";
  del.title = "Delete rule";
  del.append(icon("x"));
  del.onclick = () => saveRules(all.filter((x) => x.id !== r.id));

  row.append(chip, body, sw, del);
  return row;
}

async function saveRules(rules: Rule[]) {
  await chrome.storage.local.set({ rules });
}

async function init() {
  settings = await loadSettings();
  paint();
  void paintVotes();

  $<HTMLInputElement>("enabled").onchange = (e) => void save({ enabled: (e.target as HTMLInputElement).checked });
  $<HTMLInputElement>("analyzeImages").onchange = (e) =>
    void save({ analyzeImages: (e.target as HTMLInputElement).checked });
  $<HTMLInputElement>("syncNotInterested").onchange = (e) =>
    void save({ syncNotInterested: (e.target as HTMLInputElement).checked });
  $<HTMLInputElement>("autoLearn").onchange = (e) => void save({ autoLearn: (e.target as HTMLInputElement).checked });

  void paintRules();
  $("learn-now").onclick = () => {
    void chrome.storage.local.set({ learn: { status: "running", message: "Starting…" } });
    void chrome.runtime.sendMessage({ type: "learn" });
  };
  $<HTMLFormElement>("add-rule").onsubmit = async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("new-rule");
    const what = input.value.trim();
    if (!what) return;
    const rule: Rule = {
      id: Math.random().toString(36).slice(2, 8),
      kind: newKind,
      label: what.length > 28 ? what.slice(0, 27) + "…" : what,
      text: `${newKind === "hide" ? "Hide" : "Keep"}: ${what}`,
      question: `Is this post an example of: ${what}?`,
      source: "user",
      enabled: true,
      createdAt: Date.now(),
    };
    await saveRules([...(await loadRules()), rule]);
    input.value = "";
  };

  const conn = (k: keyof Settings["connection"]) =>
    bindText(k, () => settings.connection[k], (v) => ({ connection: { ...settings.connection, [k]: v } }));
  conn("workerUrl");
  conn("secret");
  conn("accountId");
  conn("apiToken");
  bindText("notes", () => settings.notes, (notes) => ({ notes }));

  $("test").onclick = async () => {
    const out = $("test-result");
    // Custom-domain Workers need host access; must be requested before any await (user gesture).
    const workerUrl = $<HTMLInputElement>("workerUrl").value.trim();
    if (settings.connection.mode === "worker" && /^https:\/\//.test(workerUrl)) {
      const origin = new URL(workerUrl).origin + "/*";
      if (!origin.endsWith(".workers.dev/*") && !(await chrome.permissions.request({ origins: [origin] }))) {
        out.className = "err";
        out.textContent = `filterx needs permission to reach ${origin}`;
        return;
      }
    }
    // Make sure a value still sitting in a focused input is saved first.
    (document.activeElement as HTMLElement | null)?.blur();
    await new Promise((r) => setTimeout(r, 50));
    out.className = "";
    out.textContent = "Asking Clef about a sample post…";
    const res = (await chrome.runtime.sendMessage({ type: "test" })) as ClassifyResult;
    if (res.error || !res.features) {
      out.className = "err";
      out.textContent = res.error ?? "No answer";
      return;
    }
    const f = res.features;
    out.className = "ok";
    out.textContent =
      `Connected · ${res.ms}ms\n"Who gave us the most accurate Lex Luthor?" → ` +
      `engagement bait ${Math.round(f.bait * 100)}%, low value ${Math.round(f.lowvalue * 100)}%, your taste ${Math.round(f.hide * 100)}%`;
  };

  $("export").onclick = async () => {
    const { examples = [] } = await chrome.storage.local.get("examples");
    const url = URL.createObjectURL(new Blob([JSON.stringify(examples, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "filterx-votes.json" });
    a.click();
    URL.revokeObjectURL(url);
  };
  $("import").onclick = () => $("import-file").click();
  $<HTMLInputElement>("import-file").onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const incoming = JSON.parse(await file.text()) as Example[];
    const { examples = [] } = (await chrome.storage.local.get("examples")) as { examples?: Example[] };
    const byId = new Map([...examples, ...incoming].map((x) => [x.id, x]));
    await chrome.storage.local.set({ examples: [...byId.values()].sort((a, b) => a.ts - b.ts) });
  };
  $("clear-cache").onclick = async () => {
    await chrome.storage.local.remove("cache");
    $("clear-cache").textContent = "Cache cleared";
  };
  $("reset").onclick = async () => {
    if (!confirm("Forget every vote and start learning from scratch?")) return;
    await chrome.storage.local.remove(["examples", "learned", "recent"]);
    await chrome.storage.local.set({ examples: [] });
  };

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.examples) void paintVotes();
    if (changes.rules || changes.learn || changes.examples) void paintRules();
  });
}

void init();
