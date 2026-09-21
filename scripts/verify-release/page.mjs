// Page-driving helpers: the selectors and the keyboard and mouse handling the
// release checks are written against.
import { sleep } from "./harness.mjs";

export const q = (selector) => `!!document.querySelector(${JSON.stringify(selector)})`;
export const textOf = (selector) =>
  `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "").toLowerCase()`;
export const bodyText = `document.body.innerText.toLowerCase()`;

export const click = (s, selector) =>
  s.exec(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("no element for " + ${JSON.stringify(selector)});
    el.click();
  `);

export const clickByText = (s, selector, needle) =>
  s.exec(`
    const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const want = ${JSON.stringify(needle.toLowerCase())};
    const hit = all.find((el) => (el.innerText || el.getAttribute("aria-label") || "").toLowerCase().includes(want));
    if (!hit) throw new Error("no " + ${JSON.stringify(selector)} + " matching " + want);
    hit.click();
  `);

export const setSelect = (s, selector, value) =>
  s.exec(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("no select " + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("change", { bubbles: true }));
  `);

export const setInput = (s, selector, value) =>
  s.exec(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("no input " + ${JSON.stringify(selector)});
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
  `);

const VIRTUAL = {
  Enter: 13, Escape: 27, Backspace: 8, Tab: 9, ArrowDown: 40, ArrowUp: 38,
  ArrowLeft: 37, ArrowRight: 39, End: 35, Home: 36, Delete: 46, F2: 113, " ": 32,
};

function virtualKey(k) {
  if (k.length === 1) return k.toUpperCase().charCodeAt(0);
  return VIRTUAL[k] ?? 0;
}

/** A real key event. Shortcuts read `event.key`, so both key and code are sent. */
export async function key(session, { key: k, code, ctrl = false, shift = false, alt = false, text }) {
  const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
  const base = {
    key: k,
    code,
    modifiers,
    windowsVirtualKeyCode: virtualKey(k),
    nativeVirtualKeyCode: virtualKey(k),
  };
  await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(text ? { text } : {}) });
  if (text) await session.send("Input.dispatchKeyEvent", { type: "char", ...base, text });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** The target state the diagnostics button announces. */
export const targetStatus = `(() => {
  const el = document.querySelector('button[aria-label^="Target diagnostics"]');
  if (!el) return null;
  const m = /Target diagnostics\\. Target ([^,]+), session ([^,]+),/.exec(el.getAttribute("aria-label") || "");
  return m ? { target: m[1].trim(), session: m[2].trim() } : null;
})()`;

/** Focuses Monaco by clicking its last rendered line, then moves the caret to the end. */
export async function focusEditor(session) {
  await session.exec(`
    const lines = [...document.querySelectorAll(".view-line")];
    const line = lines[lines.length - 1];
    if (!line) throw new Error("Monaco has no rendered line");
    const r = line.getBoundingClientRect();
    window.__novaClick = { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2) };
  `);
  const at = await session.eval(`window.__novaClick`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await session.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  }
  await sleep(150);
  await key(session, { key: "End", code: "End", ctrl: true });
}

export const editorText = `[...document.querySelectorAll(".view-line")].map((l) => l.innerText.replace(/\\u00a0/g, " ")).join(String.fromCharCode(10))`;

/** Opens the command palette and runs the command whose title contains `needle`. */
export async function runCommand(session, needle) {
  await key(session, { key: "P", code: "KeyP", ctrl: true, shift: true });
  await sleep(500);
  const open = await session.eval(q('input[aria-label="Search commands"]'));
  if (!open) throw new Error("the command palette did not open");
  await session.send("Input.insertText", { text: needle });
  await sleep(400);
  await session.exec(`
    const rows = [...document.querySelectorAll('[role="option"]')];
    const want = ${JSON.stringify(needle.toLowerCase())};
    // The first line of a row is the category chip, so match the whole row.
    const hit = rows.find((r) => r.innerText.toLowerCase().includes(want));
    if (!hit) throw new Error("palette has no command matching " + want + "; showed " + rows.map((r) => r.innerText.replace(/\\n/g, " ")).join(" | "));
    if (hit.getAttribute("aria-disabled") === "true") throw new Error("the command is disabled: " + hit.innerText.replace(/\\n/g, " "));
    hit.click();
  `);
  await sleep(500);
}

/** Whether the palette lists `needle`, and whether it is enabled. Leaves the palette closed. */
export async function paletteEntry(session, needle) {
  await key(session, { key: "P", code: "KeyP", ctrl: true, shift: true });
  await sleep(500);
  await session.send("Input.insertText", { text: needle });
  await sleep(400);
  const found = await session.eval(`
    (() => {
      const rows = [...document.querySelectorAll('[role="option"]')];
      const want = ${JSON.stringify(needle.toLowerCase())};
      const hit = rows.find((r) => r.innerText.toLowerCase().includes(want));
      if (!hit) return null;
      return { text: hit.innerText.replace(/\\n/g, " | "), disabled: hit.getAttribute("aria-disabled") === "true" };
    })()
  `);
  await key(session, { key: "Escape", code: "Escape" });
  await sleep(300);
  return found;
}

/** Switches the main view using the sidebar nav. */
export async function goToView(session, label) {
  await session.exec(`
    const buttons = [...document.querySelectorAll("nav button")];
    const want = ${JSON.stringify(label.toLowerCase())};
    const hit = buttons.find((b) => (b.getAttribute("aria-label") || b.innerText || "").toLowerCase().includes(want));
    if (!hit) throw new Error("no nav entry for " + want);
    hit.click();
  `);
  await sleep(600);
}

/** Opens the target diagnostics dialog. */
export async function openTargetDiagnostics(session) {
  await click(session, 'button[aria-label^="Target diagnostics"]');
  await sleep(500);
}

export async function closeDialog(session) {
  await key(session, { key: "Escape", code: "Escape" });
  await sleep(400);
}
