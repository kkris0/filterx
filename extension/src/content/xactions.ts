/**
 * Drives X's own "⋯ → Not interested in this post" menu so 👎 also trains
 * X's ranking. The menu is made invisible while this runs (see content.css,
 * html.fx-automating). Only English labels are matched for now.
 */

import { moreButtonOf } from "./dom";

const NOT_INTERESTED =/not interested in this (post|tweet)/i;

export async function markNotInterested(article: HTMLElement): Promise<boolean> {
  const caret = moreButtonOf(article);
  if (!caret) return false;
  const root = document.documentElement;
  root.classList.add("fx-automating");
  try {
    caret.click();
    const item = await waitFor(
      () =>
        [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((el) =>
          NOT_INTERESTED.test(el.textContent ?? ""),
        ),
      1_200,
    );
    if (!item) {
      closeMenu();
      return false;
    }
    item.click();
    return true;
  } finally {
    setTimeout(() => root.classList.remove("fx-automating"), 200);
  }
}

function closeMenu() {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
}

function waitFor<T>(fn: () => T | undefined, timeout: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const found = fn();
    if (found) return resolve(found);
    const obs = new MutationObserver(() => {
      const v = fn();
      if (v) {
        obs.disconnect();
        clearTimeout(t);
        resolve(v);
      }
    });
    const t = setTimeout(() => {
      obs.disconnect();
      resolve(undefined);
    }, timeout);
    obs.observe(document.body, { childList: true, subtree: true });
  });
}
