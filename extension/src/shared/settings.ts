import { CATEGORIES, DEFAULT_NOTES, defaultWeights } from "./model";
import { CATEGORY_IDS, type CategoryId, type Learned, type Rule, type Settings, type Stats } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  connection: { mode: "worker", workerUrl: "", secret: "", accountId: "", apiToken: "" },
  model: "clef",
  threshold: 0.7,
  display: "collapse",
  categories: Object.fromEntries(CATEGORY_IDS.map((c) => [c, CATEGORIES[c].defaultOn])) as Record<
    CategoryId,
    boolean
  >,
  notes: DEFAULT_NOTES,
  analyzeImages: true,
  syncNotInterested: false,
  autoLearn: true,
};

export const SENSITIVITY = [
  { label: "Relaxed", threshold: 0.85 },
  { label: "Balanced", threshold: 0.7 },
  { label: "Strict", threshold: 0.55 },
] as const;

export async function loadSettings(): Promise<Settings> {
  const { settings } = (await chrome.storage.local.get("settings")) as { settings?: Partial<Settings> };
  return mergeSettings(settings);
}

export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    connection: { ...DEFAULT_SETTINGS.connection, ...stored?.connection },
    categories: { ...DEFAULT_SETTINGS.categories, ...stored?.categories },
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = mergeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function emptyLearned(settings: Settings, rules: Rule[] = []): Learned {
  return { weights: defaultWeights(settings, rules), authors: {}, votes: {}, examples: 0 };
}

export async function loadRules(): Promise<Rule[]> {
  const { rules } = (await chrome.storage.local.get("rules")) as { rules?: Rule[] };
  return rules ?? [];
}

export async function loadLearned(settings: Settings): Promise<Learned> {
  const { learned } = (await chrome.storage.local.get("learned")) as { learned?: Learned };
  return learned ?? emptyLearned(settings);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function emptyStats(): Stats {
  return { day: today(), analyzed: 0, hidden: 0, cached: 0, errors: 0, latencyTotal: 0 };
}

export function isConfigured(s: Settings): boolean {
  const c = s.connection;
  return c.mode === "worker" ? !!c.workerUrl : !!(c.accountId && c.apiToken);
}
