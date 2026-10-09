/**
 * The two injected elements: the vote slot next to the timestamp, and the
 * slim bar that replaces a hidden post.
 */

import { icon } from "../shared/icons";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export type SlotAction = "keep" | "hide";
export type BarAction = "show" | "keep" | "undo";

/** Clicks must never reach X's article handler (which would open the post). */
function guard(root: HTMLElement, on: (action: string) => void) {
  const stop = (e: Event) => {
    e.stopPropagation();
    if (e.type === "click") {
      e.preventDefault();
      const action = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (action) on(action);
    }
  };
  for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup"]) root.addEventListener(type, stop);
}

export function createSlot(on: (a: SlotAction) => void): HTMLElement {
  const slot = el("span", "fx-slot");
  const chip = el("span", "fx-chip");
  const up = el("button", "fx-vote fx-up");
  up.type = "button";
  up.dataset.act = "keep";
  up.setAttribute("aria-label", "Show me posts like this");
  up.append(icon("up"));
  const down = el("button", "fx-vote fx-down");
  down.type = "button";
  down.dataset.act = "hide";
  down.setAttribute("aria-label", "Hide posts like this");
  down.append(icon("down"));
  slot.append(chip, up, down);
  guard(slot, (a) => on(a as SlotAction));
  return slot;
}

export function updateSlot(
  slot: HTMLElement,
  opts: { vote?: "keep" | "hide"; filtered?: string; tooltip?: string; pending?: boolean },
) {
  setData(slot, "vote", opts.vote);
  setData(slot, "filtered", opts.filtered ? "1" : undefined);
  setData(slot, "pending", opts.pending ? "1" : undefined);
  const chip = slot.firstElementChild as HTMLElement;
  if (chip.textContent !== (opts.filtered ?? "")) chip.textContent = opts.filtered ?? "";
  if (opts.tooltip) slot.title = opts.tooltip;
  else slot.removeAttribute("title");
}

export function createBar(on: (a: BarAction) => void): HTMLElement {
  const bar = el("div", "fx-bar");
  bar.setAttribute("role", "note");
  bar.append(el("span", "fx-bar-dot"), el("span", "fx-bar-text"), el("span", "fx-bar-spacer"));
  const show = el("button", "fx-bar-btn", "Show");
  show.type = "button";
  show.dataset.act = "show";
  const keep = el("button", "fx-vote fx-up");
  keep.type = "button";
  keep.dataset.act = "keep";
  keep.title = "This was fine. Show posts like this";
  keep.append(icon("up"));
  bar.append(show, keep);
  guard(bar, (a) => on(a as BarAction));
  return bar;
}

export function updateBar(bar: HTMLElement, text: string, byUser: boolean) {
  const t = bar.querySelector(".fx-bar-text")!;
  if (t.textContent !== text) t.textContent = text;
  setData(bar, "user", byUser ? "1" : undefined);
  const btn = bar.querySelector<HTMLButtonElement>(".fx-bar-btn")!;
  btn.textContent = byUser ? "Undo" : "Show";
  btn.dataset.act = byUser ? "undo" : "show";
}

function setData(e: HTMLElement, key: string, value: string | undefined) {
  if (value === undefined) {
    if (key in e.dataset) delete e.dataset[key];
  } else if (e.dataset[key] !== value) e.dataset[key] = value;
}
