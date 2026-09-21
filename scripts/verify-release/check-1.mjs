// Check 1: the core product, against a fresh profile.
import { start, stop, waitFor, sleep, createReport, assert } from "./harness.mjs";
import { q, textOf, bodyText, click, key, focusEditor, editorText, runCommand, goToView, closeDialog } from "./page.mjs";

const report = createReport("check 1: workspace, editor, Explorer and the palette");
const { child, session } = await start({ fresh: true });

const tabs = `[...document.querySelectorAll('[role="tablist"][aria-label="Open scripts"] [role="tab"]')]`;
const stored = `JSON.parse(localStorage.getItem("nova.workspace") ?? "{}")`;

/** Opens the "More actions" menu on the workspace row whose text contains `name`. */
async function rowMenu(session, name, action) {
  await session.exec(`
    const rows = [...document.querySelectorAll('[aria-label="Workspace scripts"] [role="treeitem"]')];
    const row = rows.find((r) => r.innerText.includes(${JSON.stringify(name)}));
    if (!row) throw new Error("no row for " + ${JSON.stringify(name)});
    const more = [...row.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("More actions"));
    if (!more) throw new Error("no More actions button on the row");
    more.click();
  `);
  await sleep(500);
  await session.exec(`
    const items = [...document.querySelectorAll('[role="menuitem"], [role="menu"] button')];
    const want = ${JSON.stringify(action.toLowerCase())};
    const hit = items.find((i) => i.innerText.toLowerCase().includes(want));
    if (!hit) throw new Error("no menu item for " + want + "; menu had " + items.map((i) => i.innerText.trim()).join(", "));
    hit.click();
  `);
  await sleep(600);
}

try {
  report.section("Core");

  await report.check("the application launches and the shell paints", async () => {
    const title = await session.eval(`document.title`);
    assert(await session.eval(q('[role="tablist"][aria-label="Open scripts"]')), "no script tab bar");
    return `document.title = ${JSON.stringify(title)}`;
  });

  await report.check("the workspace opens with Main.lua", async () => {
    const open = await session.eval(`${tabs}.map((t) => t.innerText.split(String.fromCharCode(10))[0])`);
    assert(open.some((t) => t.includes("Main.lua")), `tabs were ${JSON.stringify(open)}`);
    return `tabs: ${JSON.stringify(open)}`;
  });

  await report.check("the editor loads Monaco", async () => {
    await waitFor(session, q(".view-line"), 20000, "a Monaco line");
    return "Monaco rendered";
  });

  await report.check("a script edits and the unsaved state appears", async () => {
    await focusEditor(session);
    await session.send("Input.insertText", { text: "\nlocal verified = 1" });
    await waitFor(session, `${editorText}.includes("local verified = 1")`, 8000, "the typed line");
    await waitFor(session, `${tabs}.some((t) => t.innerText.toLowerCase().includes("unsaved"))`, 6000, "the unsaved marker");
    return "typed, and the tab says (unsaved changes)";
  });

  await report.check("Ctrl+S saves it, and the unsaved marker clears", async () => {
    await key(session, { key: "s", code: "KeyS", ctrl: true });
    await sleep(900);
    const dirty = await session.eval(`${tabs}.some((t) => t.innerText.toLowerCase().includes("unsaved"))`);
    assert(!dirty, "the tab still says unsaved");
    const script = await session.eval(`(${stored}.scripts ?? []).find((s) => s.name === "Main.lua") ?? null`);
    assert(script, "Main.lua is not in the stored workspace");
    // The persisted `content` IS the saved content; an unsaved buffer is kept
    // separately as `draft`, so a clean script must have no draft at all.
    assert(String(script.content).includes("local verified = 1"), "the edit was not saved");
    assert(script.draft === undefined, `an unsaved draft survived the save: ${JSON.stringify(script.draft)}`);
    return "content persisted, no draft left behind";
  });

  await report.check("a new script opens in a new tab", async () => {
    await key(session, { key: "t", code: "KeyT", ctrl: true });
    await sleep(900);
    const count = await session.eval(`${tabs}.length`);
    assert(count >= 2, `expected 2+ tabs, found ${count}`);
    return `${count} tabs open`;
  });

  await report.check("a folder is created from the sidebar", async () => {
    await click(session, 'button[title="New folder"]');
    await sleep(700);
    await session.exec(`
      const input = document.querySelector('[role="dialog"] input');
      if (!input) throw new Error("the folder dialog has no input");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "Verified Folder");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    await sleep(300);
    await session.exec(`
      const d = document.querySelector('[role="dialog"]');
      const go = [...d.querySelectorAll("button")].find((b) => /create|add|ok|save/i.test(b.innerText));
      if (!go) throw new Error("no confirm button; dialog had " + [...d.querySelectorAll("button")].map((b) => b.innerText.trim()).join(", "));
      go.click();
    `);
    const folders = await waitFor(
      session,
      `(() => { const f = (${stored}.folders ?? []).map((x) => x.name); return f.length ? f : null; })()`,
      6000,
      "the folder to be persisted",
    );
    assert(folders.includes("Verified Folder"), `folders were ${JSON.stringify(folders)}`);
    assert(!(await session.eval(`!!document.querySelector('[role="dialog"]')`)), "the dialog stayed open");
    return `folders: ${JSON.stringify(folders)}`;
  });

  await report.check("script search filters the manager and clears again", async () => {
    await session.exec(`
      const input = document.querySelector('input[aria-label="Search scripts"]');
      if (!input) throw new Error("no script search field");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "Main");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    await sleep(500);
    const shown = await session.eval(
      `[...document.querySelectorAll('[aria-label="Workspace scripts"] [role="treeitem"]')].map((n) => n.innerText.split(String.fromCharCode(10))[0])`,
    );
    assert(shown.some((n) => n.includes("Main")), `search showed ${JSON.stringify(shown)}`);
    assert(!shown.some((n) => n.includes("Verified Folder")), "a non-matching folder was still listed");
    await session.exec(`
      const input = document.querySelector('input[aria-label="Search scripts"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    await sleep(400);
    return `matched ${shown.length} entries, then cleared`;
  });

  await report.check("a script can be favorited from its menu", async () => {
    await rowMenu(session, "Main.lua", "favorite");
    const section = await session.eval(q('[aria-label="Favorite scripts"]'));
    assert(section, "the Favorites section did not appear");
    // Autosave writes 750 ms after the change, so the store is read after it.
    const favorites = await waitFor(
      session,
      `(() => { const f = (${stored}.scripts ?? []).filter((s) => s.isFavorite).map((s) => s.name); return f.length ? f : null; })()`,
      5000,
      "the favorite to be persisted",
    );
    return `favorites: ${JSON.stringify(favorites)}`;
  });

  report.section("Explorer");

  await report.check("the Explorer shows its hierarchy", async () => {
    await goToView(session, "explorer");
    await sleep(800);
    const nodes = await session.eval(`[...document.querySelectorAll('[role="treeitem"]')].length`);
    assert(nodes > 0, "the Explorer tree is empty");
    const names = await session.eval(
      `[...document.querySelectorAll('[role="treeitem"]')].slice(0, 5).map((r) => r.innerText.split(String.fromCharCode(10))[0])`,
    );
    return `${nodes} nodes, first: ${JSON.stringify(names)}`;
  });

  await report.check("selecting an object fills the Property Inspector", async () => {
    await session.exec(`
      const items = [...document.querySelectorAll('[role="treeitem"]')].filter((n) => n.innerText.includes("Camera"));
      const row = items[items.length - 1];
      if (!row) throw new Error("no Camera row");
      (row.querySelector(".tree-row") ?? row).click();
    `);
    await sleep(800);
    const inspector = await session.eval(textOf('[aria-label="Property Inspector"]'));
    assert(inspector.length > 0, "the inspector is empty");
    assert(inspector.includes("camera"), `inspector said: ${inspector.slice(0, 120)}`);
    return `inspector: ${inspector.slice(0, 80).replace(/\n/g, " | ")}`;
  });

  await report.check("Explorer properties are read-only", async () => {
    const editable = await session.eval(`
      [...document.querySelectorAll('[aria-label="Property Inspector"] input, [aria-label="Property Inspector"] textarea, [aria-label="Property Inspector"] select')]
        .filter((el) => !el.disabled && !el.readOnly).length
    `);
    assert(editable === 0, `${editable} writable property controls found`);
    return "no writable property control";
  });

  await report.check("the Explorer search finds an object", async () => {
    await session.exec(`
      const input = document.querySelector('input[aria-label="Search Explorer objects"]');
      if (!input) throw new Error("no Explorer search field");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "Baseplate");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    await sleep(600);
    const shown = await session.eval(`document.body.innerText.includes("Baseplate")`);
    assert(shown, "the search did not surface Baseplate");
    await session.exec(`
      const input = document.querySelector('input[aria-label="Search Explorer objects"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    return "Baseplate found";
  });

  report.section("Command palette");

  await report.check("the palette opens, filters and runs a command", async () => {
    await key(session, { key: "P", code: "KeyP", ctrl: true, shift: true });
    await waitFor(session, q('input[aria-label="Search commands"]'), 6000, "the palette");
    await session.send("Input.insertText", { text: "Toggle Console" });
    await sleep(500);
    const rows = await session.eval(`[...document.querySelectorAll('[role="option"]')].map((r) => r.innerText.replace(/\\n/g, " | "))`);
    assert(rows.some((r) => r.toLowerCase().includes("toggle console")), `palette showed ${JSON.stringify(rows.slice(0, 5))}`);
    await key(session, { key: "Escape", code: "Escape" });
    await sleep(400);
    return `${rows.length} matching: ${rows[0]}`;
  });

  await report.check("the palette lists every category the product has", async () => {
    await key(session, { key: "P", code: "KeyP", ctrl: true, shift: true });
    await waitFor(session, q('input[aria-label="Search commands"]'), 6000, "the palette");
    await sleep(400);
    const categories = await session.eval(`
      [...new Set([...document.querySelectorAll('[role="option"]')].map((r) => r.innerText.split(String.fromCharCode(10))[0].trim()))]
    `);
    await key(session, { key: "Escape", code: "Escape" });
    await sleep(300);
    for (const want of ["WORKSPACE", "VIEW", "CONSOLE", "EXPLORER", "TARGET", "DEBUGGER", "PROFILER", "DEVELOPER", "UPDATES", "SETTINGS"]) {
      assert(categories.includes(want), `no ${want} category; found ${JSON.stringify(categories)}`);
    }
    return categories.join(", ");
  });

  report.section("Security");

  await report.check("nothing in the UI names a process or memory operation", async () => {
    const text = await session.eval(`document.body.innerText`);
    const forbidden = ["OpenProcess", "ReadProcessMemory", "WriteProcessMemory", "CreateRemoteThread", "DLL", "anti-cheat", "bypass", "kernel", ".exe"];
    const hits = forbidden.filter((word) => text.includes(word));
    assert(hits.length === 0, `the UI mentions ${hits.join(", ")}`);
    return "no forbidden vocabulary on screen";
  });

  await report.check("no session token or secret-shaped string is stored", async () => {
    const keys = await session.eval(`Object.keys(localStorage)`);
    const blob = await session.eval(`Object.keys(localStorage).map((k) => localStorage.getItem(k)).join(" ")`);
    const hex = /[0-9a-f]{32,}/i.exec(blob);
    assert(hex === null, `a secret-shaped string is stored: ${hex?.[0]?.slice(0, 40)}`);
    assert(!/sessionToken|"token"/i.test(blob), "a token field is stored");
    return `keys: ${JSON.stringify(keys)}`;
  });

  console.log("\n--- check 1 complete ---");
} finally {
  const summary = report.finish();
  await stop(child, session);
  process.exit(summary.failed > 0 ? 1 : 0);
}
