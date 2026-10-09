import { icon } from "./shared/icons";
import { isConfigured, loadLearned, loadSettings, saveSettings, SENSITIVITY, today } from "./shared/settings";
import type { HiddenRecord, Learned, Message, Rule, Settings, Stats } from "./shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;

async function render() {
  settings = await loadSettings();
  const learned: Learned = await loadLearned(settings);
  const { stats, recent = [] } = (await chrome.storage.local.get(["stats", "recent"])) as {
    stats?: Stats;
    recent?: HiddenRecord[];
  };

  $<HTMLInputElement>("enabled").checked = settings.enabled;
  $("setup").hidden = isConfigured(settings);

  const s = stats?.day === today() ? stats : undefined;
  $("s-hidden").textContent = String(s?.hidden ?? 0);
  $("s-analyzed").textContent = String((s?.analyzed ?? 0) + (s?.cached ?? 0));
  $("s-latency").textContent = s?.analyzed ? `${Math.round(s.latencyTotal / s.analyzed)}ms` : "–";

  const sens = $("sensitivity");
  sens.replaceChildren(
    ...SENSITIVITY.map((o) => {
      const b = document.createElement("button");
      b.textContent = o.label;
      b.setAttribute("aria-pressed", String(Math.abs(settings.threshold - o.threshold) < 0.01));
      b.onclick = () => void saveSettings({ threshold: o.threshold }).then(render);
      return b;
    }),
  );
  for (const b of $("display").querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.v === settings.display));
    b.onclick = () => void saveSettings({ display: b.dataset.v as Settings["display"] }).then(render);
  }

  const list = $("recent");
  if (!recent.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = isConfigured(settings) ? "Nothing hidden yet. Go scroll." : "Waiting for a connection.";
    list.replaceChildren(empty);
  } else list.replaceChildren(...recent.map((r) => item(r, learned)));

  const n = learned.examples;
  const { rules = [] } = (await chrome.storage.local.get("rules")) as { rules?: Rule[] };
  const active = rules.filter((x) => x.enabled).length;
  $("learned").textContent = n
    ? `${n} vote${n === 1 ? "" : "s"}${active ? ` · ${active} learned rule${active === 1 ? "" : "s"}` : ""}`
    : "No votes yet";
}

function item(r: HiddenRecord, learned: Learned): HTMLElement {
  const kept = learned.votes[r.id] === "keep";
  const row = document.createElement("div");
  row.className = "item" + (kept ? " kept" : "");

  const meta = document.createElement("div");
  meta.className = "item-meta";
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = kept ? "kept" : r.reason;
  const who = document.createElement("span");
  who.textContent = `@${r.handle} · ${ago(r.ts)}`;
  meta.append(chip, who);

  const text = document.createElement("div");
  text.className = "item-text";
  text.textContent = r.summary.replace(/^@\w+:\s*/, "");

  const actions = document.createElement("div");
  actions.className = "item-actions";
  if (r.url) {
    const open = document.createElement("a");
    open.className = "icon-btn";
    open.href = r.url;
    open.target = "_blank";
    open.title = "Open post";
    open.append(icon("open"));
    actions.append(open);
  }
  if (!kept) {
    const up = document.createElement("button");
    up.className = "icon-btn up";
    up.title = "Should have stayed. Show posts like this";
    up.append(icon("up"));
    up.onclick = async () => {
      const msg: Message = {
        type: "vote",
        label: "keep",
        features: r.features,
        rules: r.rules,
        // Records from before full posts were stored only have the summary.
        post: r.post ?? {
          id: r.id,
          url: r.url,
          name: r.handle,
          handle: r.handle,
          verified: false,
          text: r.summary.replace(/^@\w+:\s*/, ""),
          page: "home",
          media: [],
          quote: r.quoteHandle ? { name: r.quoteHandle, handle: r.quoteHandle, text: "" } : undefined,
        },
      };
      await chrome.runtime.sendMessage(msg);
      await render();
    };
    actions.append(up);
  }

  row.append(meta, actions, text);
  return row;
}

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

$<HTMLInputElement>("enabled").onchange = (e) =>
  void saveSettings({ enabled: (e.target as HTMLInputElement).checked });

chrome.storage.onChanged.addListener((changes) => {
  if (changes.stats || changes.recent || changes.learned || changes.rules) void render();
});

void render();
