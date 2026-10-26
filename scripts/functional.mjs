#!/usr/bin/env node
/**
 * Functional checks for Drawdown, run against a built and started app.
 *
 *   pnpm build
 *   pnpm exec next start -p 3300      (in another shell)
 *   pnpm functional
 *
 * Environment:
 *   FUNC_BASE  app origin                  (default http://localhost:3300)
 *   FUNC_API   risk API origin             (default http://localhost:8300), used only by builds that have one
 *   FUNC_OUT   directory for the JSON report and failure screenshots (optional)
 *   FUNC_ONLY  run one configuration: desktop-dark, desktop-light, phone-dark or phone-light
 *
 * The script detects whether the build talks to the risk API (the upload dialog has a file
 * input) and runs the matching checks. It never calls the Claude API. Live mode is entered
 * with a well-formed placeholder key that is never submitted to the analyst, and the one
 * live path that is exercised (no API configured) fails locally before any request.
 *
 * Every check asserts something visible or a value. After each check the script fails if the
 * page scrolls sideways past the viewport, or if the console or the page logged an error.
 * Exits 1 when any check fails.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = (process.env.FUNC_BASE ?? "http://localhost:3300").replace(/\/+$/, "");
const API = (process.env.FUNC_API ?? "http://localhost:8300").replace(/\/+$/, "");
const OUT = process.env.FUNC_OUT ?? null;
const ONLY = process.env.FUNC_ONLY ?? null;

const sample = JSON.parse(
  readFileSync(new URL("../fixtures/sample.json", import.meta.url), "utf8"),
);
const analyst = JSON.parse(
  readFileSync(new URL("../fixtures/analyst.json", import.meta.url), "utf8"),
);
const { analysis } = sample;

const CONFIGS = [
  { name: "desktop-dark", width: 1280, height: 800, theme: "dark", phone: false },
  { name: "desktop-light", width: 1280, height: 800, theme: "light", phone: false },
  { name: "phone-dark", width: 390, height: 844, theme: "dark", phone: true },
  { name: "phone-light", width: 390, height: 844, theme: "light", phone: true },
];

// Same rules as lib/format.ts, so the page's text can be compared with the bundle.
const MINUS = "−";
function pct(value, decimals = 1) {
  const text = `${Math.abs(value * 100).toFixed(decimals)}%`;
  return value < 0 && Number(text.slice(0, -1)) !== 0 ? `${MINUS}${text}` : text;
}
function signedPct(value, decimals = 1) {
  const text = pct(value, decimals);
  return value > 0 && !text.startsWith(MINUS) && Number(text.slice(0, -1)) !== 0
    ? `+${text}`
    : text;
}
function num(value, decimals = 2) {
  const text = Math.abs(value).toFixed(decimals);
  return value < 0 && Number(text) !== 0 ? `${MINUS}${text}` : text;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const results = [];
let state = null; // the configuration being run

function record(name, ok, detail) {
  const entry = { config: state.config.name, check: name, ok, detail: detail ?? "" };
  results.push(entry);
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark} [${state.config.name}] ${name}${ok || !detail ? "" : ` :: ${detail}`}`);
}

/** Runs one check, then the layout and console checks that apply after every interaction. */
async function check(name, fn) {
  try {
    await fn();
    const { page } = state;
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    assert(
      widths.scroll <= widths.viewport,
      `page scrolls sideways: scrollWidth ${widths.scroll} > ${widths.viewport}`,
    );
    const problems = state.problems
      .splice(0)
      .filter((line) => !(state.allowNetwork && /Failed to load resource/.test(line)));
    assert(problems.length === 0, `page errors: ${problems.slice(0, 2).join(" | ")}`);
    record(name, true);
  } catch (error) {
    state.problems.splice(0);
    const message = String(error?.message ?? error)
      .split("\n")[0]
      .slice(0, 300);
    record(name, false, message);
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      const file = path.join(OUT, `fail-${state.config.name}-${results.length}.png`);
      await state.page.screenshot({ path: file, fullPage: false }).catch(() => {});
    }
  } finally {
    state.allowNetwork = false;
  }
}

/** The text as written, without CSS transforms (innerText would turn uppercase labels into capitals). */
async function visibleText(locator) {
  await locator.first().waitFor({ state: "visible" });
  return locator.first().textContent();
}

/** Waits (up to 10 seconds) for the text to appear, since messages often follow a request. */
async function expectText(locator, expected) {
  let text = await visibleText(locator);
  const started = Date.now();
  while (!text.includes(expected) && Date.now() - started < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    text = await locator.first().textContent();
  }
  assert(
    text.includes(expected),
    `expected "${expected}" in: "${text.replace(/\s+/g, " ").slice(0, 160)}"`,
  );
}

/** Finds a point over the frontier where a hover tooltip appears, by sweeping a grid. */
async function findFrontierTooltip(page, canvas, card) {
  const box = await canvas.boundingBox();
  assert(box, "frontier canvas has no box");
  const tip = card.locator('[role="status"]');
  for (let fy = 0.06; fy < 0.95; fy += 0.07) {
    for (let fx = 0.06; fx < 0.95; fx += 0.05) {
      const x = box.x + box.width * fx;
      const y = box.y + box.height * fy;
      await page.mouse.move(x, y);
      if ((await tip.count()) > 0 && (await tip.first().innerText()).includes("Worst fall")) {
        return { x, y };
      }
    }
  }
  return null;
}

const sectionFor = (page, id) => page.locator(`section[aria-labelledby="${id}"]`);
const analystPanel = (page) => page.locator("section#analyst");
const keyDialog = (page) => page.locator("dialog").filter({ hasText: "Add your Anthropic key" });
const uploadDialog = (page) => page.locator('dialog[aria-labelledby="upload-title"]');

function csvFile(text) {
  return { name: "holdings.csv", mimeType: "text/csv", buffer: Buffer.from(text) };
}

function fixtureFacts(demoId) {
  const session = analyst[demoId].data;
  const perRound = new Map();
  for (const call of session.calls) perRound.set(call.round, (perRound.get(call.round) ?? 0) + 1);
  const note = (analyst[demoId].events ?? []).find((item) => item.event.type === "note");
  return {
    calls: session.calls.length,
    numbers: session.provenance.numbers.length,
    matched: session.provenance.matched,
    perRound,
    note: note ? note.event.text : null,
  };
}

async function readNarration(page) {
  const line = page.locator("section#analyst [data-narration]");
  return (await line.count()) > 0 ? (await line.first().textContent()).trim() : "";
}

/** Narration lines seen during the last replay, in order. */
let lastNarration = [];

/** Plays a preset and waits for the checked answer. */
async function playPreset(page, demoId) {
  const panel = analystPanel(page);
  await panel.locator(`[data-preset="${demoId}"]`).click();
  await panel.locator('[data-session="running"]').waitFor({ state: "visible", timeout: 5000 });
  const seen = [];
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const line = await readNarration(page);
    if (line && seen.at(-1) !== line) seen.push(line);
    if ((await panel.locator('[data-session="done"]').count()) > 0) {
      lastNarration = seen;
      return seen;
    }
    await page.waitForTimeout(120);
  }
  throw new Error(`preset ${demoId} did not finish within 60 seconds`);
}

async function runAnalystChecks(page) {
  const panel = analystPanel(page);

  await check("F15 three presets are offered and enabled in demo mode", async () => {
    const presets = panel.locator("[data-preset]");
    assert((await presets.count()) === 3, `expected 3 presets, got ${await presets.count()}`);
    for (const id of ["risk-sources", "market-drop", "trim-tech"]) {
      assert(await panel.locator(`[data-preset="${id}"]`).isEnabled(), `${id} is disabled`);
    }
  });

  await check("F22 own-question box explains that it needs a key", async () => {
    const input = panel.locator("input");
    assert(await input.isDisabled(), "own-question input is enabled without a key");
    assert((await input.getAttribute("placeholder")) === "Needs your Anthropic key", "placeholder");
    await expectText(panel, "Your own questions call Claude live, so they need a key.");
    assert(await panel.locator('button:text-is("Ask")').isDisabled(), "Ask is enabled");
  });

  await check("F15 sample session 'risk-sources' replays to a checked answer", async () => {
    const facts = fixtureFacts("risk-sources");
    await playPreset(page, "risk-sources");
    await expectText(panel, `${facts.matched} of ${facts.numbers} figures traced to a tool output`);
    await expectText(panel, `Code checked all ${facts.numbers} numbers in the answer`);
    await expectText(panel, "Sample (not a real run)");
    await expectText(panel, "Sample session: the analyst's notes and answer are pre-written");
    assert(
      (await panel.locator('[data-verdict="clean"]').count()) === 1,
      "verdict is not clean for the bundled answer",
    );
  });

  await check("F16 the trail narrates progress between tool calls", async () => {
    const facts = fixtureFacts("risk-sources");
    await expectText(panel, facts.note);
    assert(
      lastNarration.length >= 2,
      `only ${lastNarration.length} narration line(s) during the run`,
    );
  });

  await check("F17 trail groups calls by round and reports parallel calls", async () => {
    const facts = fixtureFacts("risk-sources");
    assert((await panel.locator("details").count()) === facts.calls, "row count != calls");
    for (const [round, count] of facts.perRound) {
      const label =
        count > 1 ? `${count} tool calls in parallel` : count === 1 ? "1 tool call" : null;
      if (label) await expectText(panel, label);
      await expectText(panel, `Round ${round}`);
    }
  });

  await check("F17 a tool-call row expands to its input and output", async () => {
    const row = panel.locator("details").first();
    assert(!(await row.evaluate((el) => el.open)), "row starts open");
    await row.locator("summary").click();
    assert(await row.evaluate((el) => el.open), "row did not open on click");
    const body = await row.locator("pre").innerText();
    assert(
      body.includes('"input"') && body.includes('"output"'),
      "expanded row lacks input/output",
    );
    await row.locator("summary").click();
    assert(!(await row.evaluate((el) => el.open)), "row did not close on second click");
  });

  await check("F18 a number chip selects the tool call that produced it", async () => {
    const chip = panel.locator('button[data-status="matched"]').first();
    const label = await chip.getAttribute("aria-label");
    const match = /from tool call (\d+)/.exec(label ?? "");
    assert(match, `chip label has no call number: "${label}"`);
    const index = match[1];
    await chip.click();
    assert((await chip.getAttribute("aria-pressed")) === "true", "chip is not pressed");
    const source = panel.locator('p[role="status"]').filter({ hasText: "←" });
    await expectText(source, `← call ${index},`);
    const row = panel.locator("details").nth(Number(index) - 1);
    assert(
      (await row.getAttribute("class"))?.includes("border-accent"),
      "the matching tool-call row is not highlighted",
    );
    assert((await chip.locator("sup").innerText()).trim() === index, "chip superscript differs");
  });

  await check("F19 the checker reports every figure traced in the bundled answer", async () => {
    await expectText(panel, "every number checked by code");
    assert(
      (await panel.locator('button[data-status="unmatched"]').count()) === 0,
      "a bundled figure is unmatched",
    );
  });

  await check("F20 self-test alters one figure and the checker flags it in red", async () => {
    const button = panel.locator('[data-action="self-test"]');
    await button.click();
    assert(
      (await button.innerText()).includes("Show the real answer"),
      "self-test button label did not change",
    );
    await panel.locator('[data-verdict="flagged"]').waitFor({ state: "visible" });
    await expectText(panel, "not from a tool");
    await expectText(panel, "This page changed");
    assert(
      (await panel.locator('button[data-status="unmatched"]').count()) >= 1,
      "no red chip after the alteration",
    );
    await button.click();
    await panel.locator('[data-verdict="clean"]').waitFor({ state: "visible" });
  });

  await check("F21 Stop cancels a running replay", async () => {
    await panel.locator('[data-preset="market-drop"]').click();
    const stop = panel.getByRole("button", { name: "Stop", exact: true });
    await stop.waitFor({ state: "visible", timeout: 5000 });
    await stop.click();
    await panel.locator('[data-session="stopped"]').waitFor({ state: "visible" });
    await expectText(panel, "Stopped.");
    await expectText(panel, "No answer: the run was stopped before the analyst finished.");
    assert(await panel.locator('[data-preset="trim-tech"]').isEnabled(), "presets stayed locked");
  });

  await check("F15 sample session 'market-drop' replays to a checked answer", async () => {
    const facts = fixtureFacts("market-drop");
    await playPreset(page, "market-drop");
    await expectText(panel, `${facts.matched} of ${facts.numbers} figures traced to a tool output`);
  });

  await check("F15 sample session 'trim-tech' replays to a checked answer", async () => {
    const facts = fixtureFacts("trim-tech");
    await playPreset(page, "trim-tech");
    await expectText(panel, `${facts.matched} of ${facts.numbers} figures traced to a tool output`);
    await expectText(panel, `Code checked all ${facts.numbers} numbers in the answer`);
  });

  await check("F15 the main button plays a sample session and says so while it runs", async () => {
    const cta = page.locator('[data-cta="play"]');
    assert(
      (await cta.innerText()).includes("Play a sample analyst session"),
      `CTA label was "${await cta.innerText()}"`,
    );
    await cta.click();
    await page.waitForFunction(
      () => document.querySelector('[data-cta="play"]')?.textContent?.includes("Playing"),
      null,
      { timeout: 5000 },
    );
    assert(await cta.isDisabled(), "CTA is enabled while playing");
    await panel.locator('[data-session="done"]').waitFor({ state: "visible", timeout: 60000 });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-cta="play"]')?.textContent?.includes("Play a sample analyst"),
      null,
      { timeout: 5000 },
    );
  });
}

async function runKeyChecks(page) {
  await check("F26 demo banner says the answers are samples and offers a key", async () => {
    await expectText(page.getByRole("status").filter({ hasText: "Demo:" }), "pre-written examples");
    assert(
      await page.getByRole("button", { name: "Add key", exact: true }).first().isVisible(),
      "no Add key button",
    );
  });

  await check("F24 a key without the right shape is refused, the dialog stays open", async () => {
    await page.getByRole("button", { name: "Add key", exact: true }).first().click();
    const dialog = keyDialog(page);
    await expectText(dialog, "Add your Anthropic key");
    await dialog.locator('input[name="key"]').fill("sk-ant-short");
    await dialog.getByRole("button", { name: "Use this key" }).click();
    await expectText(dialog, "Anthropic keys start with sk-ant-");
    assert(await dialog.isVisible(), "dialog closed on a bad key");
  });

  await check("F38 Escape closes the key dialog", async () => {
    await page.keyboard.press("Escape");
    await keyDialog(page).waitFor({ state: "hidden" });
  });

  await check("F24 Cancel closes the key dialog without changing the key", async () => {
    await page.getByRole("button", { name: "Add key", exact: true }).first().click();
    await keyDialog(page).getByRole("button", { name: "Cancel" }).click();
    await keyDialog(page).waitFor({ state: "hidden" });
    await expectText(page.getByRole("status").filter({ hasText: "Demo:" }), "pre-written examples");
  });

  await check("F25 a well-formed key switches on live mode without sending anything", async () => {
    const requests = [];
    const watch = (request) => {
      if (request.url().includes("/api/")) requests.push(request.url());
    };
    page.on("request", watch);
    await page.getByRole("button", { name: "Add key", exact: true }).first().click();
    const dialog = keyDialog(page);
    // A placeholder in the right shape, never a real credential, and never submitted to the analyst.
    await dialog.locator('input[name="key"]').fill("sk-ant-test-0000000000000000");
    await dialog.getByRole("button", { name: "Use this key" }).click();
    await keyDialog(page).waitFor({ state: "hidden" });
    await expectText(page.locator("body"), "Live — calling Claude Opus 5.5 with your key.");
    assert(
      (await page.locator('[data-cta="play"]').innerText()).includes("Ask the analyst"),
      "CTA does not offer a live ask",
    );
    const input = analystPanel(page).locator("input");
    assert(await input.isEnabled(), "own-question box stayed disabled in live mode");
    await expectText(analystPanel(page), "Runs on your key.");
    const stored = await page.evaluate(() => ({
      session: window.sessionStorage.getItem("anthropic-key"),
      local: Object.values(window.localStorage).some((v) => String(v).includes("sk-ant")),
    }));
    assert(stored.session === null, "key was written to sessionStorage without 'remember'");
    assert(!stored.local, "key was written to localStorage");
    page.off("request", watch);
    assert(
      requests.length === 0,
      `requests were sent when the key was set: ${requests.join(", ")}`,
    );
  });

  await check(
    "F24 Change key opens the dialog with Remove key, which restores demo mode",
    async () => {
      await page.getByRole("button", { name: "Change key", exact: true }).click();
      const dialog = keyDialog(page);
      await dialog.getByRole("button", { name: "Remove key" }).waitFor({ state: "visible" });
      await dialog.getByRole("button", { name: "Remove key" }).click();
      await keyDialog(page).waitFor({ state: "hidden" });
      await expectText(
        page.getByRole("status").filter({ hasText: "Demo:" }),
        "pre-written examples",
      );
    },
  );

  await check("F24 a key kept for the tab is restored after a reload", async () => {
    await page.getByRole("button", { name: "Add key", exact: true }).first().click();
    const dialog = keyDialog(page);
    await dialog.locator('input[name="key"]').fill("sk-ant-test-1111111111111111");
    await dialog.locator('input[name="remember"]').check();
    await dialog.getByRole("button", { name: "Use this key" }).click();
    await keyDialog(page).waitFor({ state: "hidden" });
    await page.reload({ waitUntil: "load" });
    await expectText(page.locator("body"), "Live — calling Claude Opus 5.5 with your key.");
    // Clear it again so the rest of the run starts in demo mode.
    await page.getByRole("button", { name: "Change key", exact: true }).click();
    await keyDialog(page).getByRole("button", { name: "Remove key" }).click();
    await keyDialog(page).waitFor({ state: "hidden" });
    await expectText(page.getByRole("status").filter({ hasText: "Demo:" }), "pre-written examples");
  });
}

async function runNoApiChecks(page) {
  await check("F30 load-your-holdings explains that no risk API is connected", async () => {
    await page.getByRole("button", { name: "Or load your own holdings" }).click();
    const dialog = uploadDialog(page);
    await expectText(dialog, "this deployment is not connected to one");
    assert((await dialog.locator("#holdings-file").count()) === 0, "upload input shown");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await uploadDialog(page).waitFor({ state: "hidden" });
  });

  await check(
    "F49 a live ask with no risk API configured fails locally with a clear message",
    async () => {
      const requests = [];
      const watch = (request) => {
        if (request.url().includes("/api/")) requests.push(request.url());
      };
      page.on("request", watch);
      await page.getByRole("button", { name: "Add key", exact: true }).first().click();
      const dialog = keyDialog(page);
      await dialog.locator('input[name="key"]').fill("sk-ant-test-2222222222222222");
      await dialog.getByRole("button", { name: "Use this key" }).click();
      await keyDialog(page).waitFor({ state: "hidden" });
      const panel = analystPanel(page);
      await panel.locator("input").fill("What if bonds fall 15%?");
      await panel.getByRole("button", { name: "Ask", exact: true }).click();
      await expectText(panel, "This deployment is not connected to the risk engine API");
      page.off("request", watch);
      assert(requests.length === 0, `a request reached the API: ${requests.join(", ")}`);
      await page.getByRole("button", { name: "Change key", exact: true }).click();
      await keyDialog(page).getByRole("button", { name: "Remove key" }).click();
      await keyDialog(page).waitFor({ state: "hidden" });
    },
  );

  await check("F30 the dashboard does not offer upload controls without an API", async () => {
    assert(
      (await page.getByRole("button", { name: "Back to the sample" }).count()) === 0,
      "back button shown",
    );
    assert(await page.locator('[data-cta="play"]').isEnabled(), "CTA disabled without an upload");
  });
}

async function runUploadChecks(page) {
  await check("F31 load-your-holdings explains the CSV and offers an example", async () => {
    await page.getByRole("button", { name: "Or load your own holdings" }).click();
    const dialog = uploadDialog(page);
    await expectText(dialog, "A CSV with a");
    await expectText(dialog, "The 52 symbols that can be analysed");
    const link = dialog.locator('a[href="/sample-holdings.csv"][download]');
    assert((await link.count()) === 1, "example link missing");
  });

  await check("F31 the example CSV downloads with its expected content", async () => {
    const link = uploadDialog(page).locator('a[href="/sample-holdings.csv"][download]');
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    assert(download.suggestedFilename() === "sample-holdings.csv", download.suggestedFilename());
    const body = readFileSync(await download.path(), "utf8");
    assert(body.startsWith("ticker,value") && body.includes("NVDA,35000"), "unexpected content");
  });

  await check("F39 Enter on the 'Choose a CSV file' label opens the file picker", async () => {
    const label = uploadDialog(page).locator('label[for="holdings-file"]');
    assert((await label.getAttribute("role")) === "button", "label is not a button");
    assert((await label.getAttribute("tabindex")) === "0", "label is not focusable");
    await label.focus();
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("for") ?? "");
    assert(focused === "holdings-file", `focus is on "${focused || "something else"}"`);
    const chooser = page.waitForEvent("filechooser", { timeout: 5000 });
    await page.keyboard.press("Enter");
    await chooser;
  });

  await check("F38 the Close button and Escape dismiss the upload dialog", async () => {
    await uploadDialog(page).getByRole("button", { name: "Close", exact: true }).click();
    await uploadDialog(page).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Or load your own holdings" }).click();
    await uploadDialog(page).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await uploadDialog(page).waitFor({ state: "hidden" });
  });

  await check("F38 a click on the backdrop dismisses the upload dialog", async () => {
    await page.getByRole("button", { name: "Or load your own holdings" }).click();
    await uploadDialog(page).waitFor({ state: "visible" });
    await page.mouse.click(4, 4);
    await uploadDialog(page).waitFor({ state: "hidden" });
  });

  await check(
    "F32 a bad ticker gives the universe message, and the dialog stays open",
    async () => {
      state.allowNetwork = true; // the API's 400 is logged by the browser as a failed resource
      await page.getByRole("button", { name: "Or load your own holdings" }).click();
      const dialog = uploadDialog(page);
      await dialog
        .locator("#holdings-file")
        .setInputFiles(csvFile("ticker,value\nZZZZ,1000\nAAPL,1000\n"));
      await expectText(dialog, "Not in the bundled universe of 52 tickers: ZZZZ.");
      assert(await dialog.isVisible(), "dialog closed on an error");
    },
  );

  await check("F33 an oversized file is refused in the browser with the limit", async () => {
    const before = state.apiRequests;
    state.allowNetwork = true; // an earlier request may still be settling
    const dialog = uploadDialog(page);
    const big = `ticker,value\nAAPL,1000\n${" ".repeat(33000)}`;
    await dialog.locator("#holdings-file").setInputFiles(csvFile(big));
    await expectText(dialog, "That file is too large. The limit is 32 KB.");
    assert(state.apiRequests === before, "an oversized file was still sent");
  });

  await check("F34 a missing ticker column gets its explanation", async () => {
    state.allowNetwork = true;
    const dialog = uploadDialog(page);
    await dialog.locator("#holdings-file").setInputFiles(csvFile("name,amount\nAAPL,1\nMSFT,2\n"));
    await expectText(dialog, 'The header needs a "ticker" column');
  });

  await check("F34 a non-numeric amount names its row", async () => {
    state.allowNetwork = true;
    const dialog = uploadDialog(page);
    await dialog
      .locator("#holdings-file")
      .setInputFiles(csvFile("ticker,value\nAAPL,abc\nMSFT,2000\n"));
    await expectText(dialog, "Row 2: the amount is not a number.");
  });

  await check("F35 an unreachable risk API gives a plain message", async () => {
    state.allowNetwork = true;
    await page.route(`${API}/api/portfolio`, (route) => route.abort());
    try {
      const dialog = uploadDialog(page);
      await dialog
        .locator("#holdings-file")
        .setInputFiles(csvFile("ticker,value\nAAPL,1000\nMSFT,2000\n"));
      await expectText(dialog, "The risk engine API did not answer.");
    } finally {
      await page.unroute(`${API}/api/portfolio`);
    }
  });

  await check("F36 an error envelope from the API is shown as its message", async () => {
    state.allowNetwork = true;
    await page.route(`${API}/api/portfolio`, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { kind: "server", message: "The risk engine had a problem. Try again." },
        }),
      }),
    );
    try {
      const dialog = uploadDialog(page);
      await dialog
        .locator("#holdings-file")
        .setInputFiles(csvFile("ticker,value\nAAPL,1000\nMSFT,2000\n"));
      await expectText(dialog, "The risk engine had a problem. Try again.");
    } finally {
      await page.unroute(`${API}/api/portfolio`);
    }
  });

  await check("F02 a valid CSV reaches the API and replaces the sample", async () => {
    const dialog = uploadDialog(page);
    await dialog
      .locator("#holdings-file")
      .setInputFiles(csvFile("ticker,value\nAAPL,12000\nJPM,8000\nTLT,5000\n"));
    await page.getByRole("heading", { name: "A risk report for your holdings" }).waitFor({
      state: "visible",
      timeout: 20000,
    });
    await uploadDialog(page).waitFor({ state: "hidden" });
    await expectText(page.locator("body"), "3 holdings, $25,000");
    const holdings = sectionFor(page, "holdings-title");
    for (const ticker of ["AAPL", "JPM", "TLT"]) await expectText(holdings, ticker);
    assert((await holdings.locator("tbody tr").count()) === 3, "holdings table is not 3 rows");
  });

  await check("F48 uploaded holdings drive the frontier and the analysis", async () => {
    await expectText(sectionFor(page, "frontier-title"), "of the same 3 holdings");
    await page.locator('[data-frontier][data-ready="true"]').first().waitFor({ timeout: 30000 });
  });

  await check(
    "F23 sample presets and the main button are switched off for uploaded holdings",
    async () => {
      for (const id of ["risk-sources", "market-drop", "trim-tech"]) {
        assert(
          await analystPanel(page).locator(`[data-preset="${id}"]`).isDisabled(),
          `${id} enabled`,
        );
      }
      assert(await page.locator('[data-cta="play"]').isDisabled(), "CTA enabled");
      await expectText(analystPanel(page), "switched off for your holdings");
    },
  );

  await check("F37 Back to the sample restores the sample portfolio", async () => {
    await page.getByRole("button", { name: "Back to the sample" }).click();
    await page
      .getByRole("heading", { name: "A risk report for a sample stock portfolio" })
      .waitFor({ state: "visible" });
    assert(await page.locator('[data-cta="play"]').isEnabled(), "CTA still disabled");
  });
}

async function runCommonChecks(page, config) {
  await check("F01 the first screen shows the sample portfolio, fully computed", async () => {
    await expectText(page.locator("h1"), "A risk report for a sample stock portfolio");
    assert(
      (await page.title()) === "Drawdown: portfolio risk X-ray",
      `title ${await page.title()}`,
    );
    const tiles = sectionFor(page, "numbers-title").locator("dl > div");
    assert((await tiles.count()) === 8, `expected 8 metric tiles, got ${await tiles.count()}`);
    assert(
      (await page.locator('ol[aria-label="How it works"] > li').count()) === 3,
      "no 3-step strip",
    );
    if (config.phone) {
      const box = await page.locator('[data-cta="play"]').boundingBox();
      assert(box && box.y + box.height <= config.height, "main button is below the phone fold");
    }
  });

  await check("F27 the educational banner is persistent and sticks to the top", async () => {
    const note = page.locator('[role="note"]');
    await expectText(note, "Educational only. Not financial advice.");
    await expectText(note, "Prices are simulated for demonstration");
    const position = await note.evaluate((el) => getComputedStyle(el).position);
    assert(position === "sticky", `position is ${position}`);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(150);
    const top = await note.evaluate((el) => el.getBoundingClientRect().top);
    assert(Math.abs(top) < 1, `banner top is ${top} after scrolling`);
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  await check("F03 the header and dataset say the prices are simulated", async () => {
    await expectText(sectionFor(page, "numbers-title").locator("header"), "(simulated)");
  });

  await check(
    "F04 the metric tiles match the engine's numbers, with the market comparison",
    async () => {
      const m = analysis.metrics;
      const expected = {
        "Annual return": pct(m.annualReturn),
        "Max drawdown": pct(m.maxDrawdown.depth),
        Volatility: pct(m.volatility),
        "Beta vs SPY": num(m.beta),
        "Sharpe ratio": num(m.sharpe),
        "Sortino ratio": num(m.sortino),
        "VaR 95%, 1 day": pct(m.var95, 2),
        "CVaR 95%, 1 day": pct(m.cvar95, 2),
      };
      const tiles = sectionFor(page, "numbers-title").locator("dl > div");
      const seen = {};
      for (let i = 0; i < (await tiles.count()); i++) {
        const tile = tiles.nth(i);
        const label = (await tile.locator("dt span").first().textContent()).trim();
        seen[label] = (await tile.locator("dd").first().textContent()).trim();
        const hint = await tile.getAttribute("title");
        assert(hint && hint.length > 10, `tile "${label}" has no tooltip definition`);
      }
      for (const [label, value] of Object.entries(expected)) {
        assert(seen[label] === value, `${label}: shown "${seen[label]}", engine says "${value}"`);
      }
      const annual = sectionFor(page, "numbers-title").locator("dl > div").first();
      await expectText(annual, `Market (SPY) ${pct(analysis.benchmark.annualReturn)}`);
    },
  );

  await check("F06 the drawdown chart reads values by date from the keyboard", async () => {
    const chart = page.locator('[aria-label^="Growth of one dollar"]');
    await chart.focus();
    await page.keyboard.press("ArrowRight");
    await expectText(chart, "Below high");
    const before = await chart.locator('[role="status"]').innerText();
    await page.keyboard.press("Shift+ArrowRight");
    const after = await chart.locator('[role="status"]').innerText();
    assert(before !== after, "the read-out did not move when stepping through dates");
    await page.keyboard.press("Tab");
  });

  await check("F07 the correlation heatmap reads each pair from the keyboard", async () => {
    const grid = page.locator('[aria-label^="Correlation matrix"]');
    await grid.focus();
    const status = sectionFor(page, "correlation-title").locator('[role="status"]');
    await expectText(status, "/");
    const first = await status.innerText();
    await page.keyboard.press("ArrowRight");
    const second = await status.innerText();
    assert(second.includes("correlation") && first !== second, `read-out: "${second}"`);
    await expectText(sectionFor(page, "correlation-title"), "Most alike:");
    await expectText(sectionFor(page, "correlation-title"), "Least alike:");
    await page.keyboard.press("Tab");
  });

  await check("F08 sector exposure lists every sector in the bundle", async () => {
    const card = sectionFor(page, "sectors-title");
    for (const row of analysis.sectors) await expectText(card, row.sector);
  });

  await check("F09 the Monte Carlo fan describes its median and percentiles", async () => {
    const fan = page.locator('[role="img"][aria-label^="Simulated one-year outcomes"]');
    assert((await fan.count()) === 1, "no Monte Carlo figure");
    const label = await fan.getAttribute("aria-label");
    assert(label.includes(`Median ${signedPct(analysis.monteCarlo.percentiles.p50)}`), label);
  });

  await check("F10 the holdings table lists every holding", async () => {
    const table = sectionFor(page, "holdings-title");
    assert((await table.locator("tbody tr").count()) === analysis.holdings.length, "row count");
    for (const holding of analysis.holdings) await expectText(table, holding.ticker);
  });

  await check("F11 the frontier renders with its three highlighted portfolios", async () => {
    await page.locator('[data-frontier][data-ready="true"]').first().waitFor({ timeout: 30000 });
    const rows = sectionFor(page, "frontier-title").locator("tbody tr");
    assert((await rows.count()) === 3, "highlight table is not 3 rows");
    await expectText(sectionFor(page, "frontier-title"), "This portfolio");
    await expectText(sectionFor(page, "frontier-title"), "Best Sharpe");
    await expectText(sectionFor(page, "frontier-title"), "Lowest volatility");
  });

  await check("F12 the frontier switches to the 2D fallback and back", async () => {
    const card = sectionFor(page, "frontier-title");
    const toTwoD = card.getByRole("button", { name: "Show in 2D", exact: true });
    if ((await toTwoD.count()) === 0) {
      // No WebGL here: the frontier already draws in 2D, and the 3D toggle is gone.
      await page.locator('[data-frontier="2d"][data-ready="true"]').waitFor({ timeout: 10000 });
      return;
    }
    await toTwoD.click();
    await page.locator('[data-frontier="2d"][data-ready="true"]').waitFor({ timeout: 10000 });
    assert(
      await card.getByRole("button", { name: "Show in 3D", exact: true }).isVisible(),
      "no 3D toggle",
    );
    await card.getByRole("button", { name: "Show in 3D", exact: true }).click();
    await page.locator('[data-frontier="3d"][data-ready="true"]').waitFor({ timeout: 20000 });
  });

  await check("F13 the 2D frontier shows a hover tooltip and a press shows it too", async () => {
    const card = sectionFor(page, "frontier-title");
    const toTwoD = card.getByRole("button", { name: "Show in 2D", exact: true });
    if ((await toTwoD.count()) > 0) await toTwoD.click();
    const canvas = page.locator('[data-frontier="2d"]');
    await canvas.waitFor({ state: "visible", timeout: 10000 });
    const point = await findFrontierTooltip(page, canvas, card);
    assert(point, "no hover tooltip found over the 2D frontier");
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
    await card.locator('[role="status"]').first().waitFor({ state: "visible" });
    assert((await card.locator('[role="status"]').count()) > 0, "press lost the tooltip");
    if ((await card.getByRole("button", { name: "Show in 3D", exact: true }).count()) > 0) {
      await card.getByRole("button", { name: "Show in 3D", exact: true }).click();
      await page.locator('[data-frontier="3d"][data-ready="true"]').waitFor({ timeout: 20000 });
    }
  });

  await check("F13 the 3D frontier shows a hover tooltip over the cloud", async () => {
    const card = sectionFor(page, "frontier-title");
    const canvas = page.locator('[data-frontier="3d"]');
    if ((await canvas.count()) === 0) return; // 2D fallback in this browser; covered above
    await canvas.waitFor({ state: "visible" });
    await page.locator('[data-frontier="3d"][data-ready="true"]').waitFor({ timeout: 20000 });
    const host = page.locator('[role="group"][aria-label^="3D scatter"]');
    const point = await findFrontierTooltip(page, host, card);
    assert(point, "no hover tooltip over the 3D cloud");
    await page.mouse.down();
    await page.mouse.move(point.x + 40, point.y + 10, { steps: 4 });
    await page.mouse.up();
    assert(
      (await card.locator('[role="status"]').count()) === 0 ||
        !(await card.locator('[role="status"]').first().innerText()).includes("Worst fall"),
      "a press did not hide the tooltip before the drag",
    );
  });

  await check("F14 the 3D frontier rotate toggle and arrow keys respond", async () => {
    const card = sectionFor(page, "frontier-title");
    const pause = card.getByRole("button", { name: "Pause rotation", exact: true });
    if ((await pause.count()) === 0) return; // no 3D view in this browser
    await pause.click();
    assert(
      (await card
        .getByRole("button", { name: "Rotate", exact: true })
        .getAttribute("aria-pressed")) === "false",
      "Rotate is still pressed after pausing",
    );
    await card.getByRole("button", { name: "Rotate", exact: true }).click();
    await card.getByRole("button", { name: "Pause rotation", exact: true }).waitFor();
    await page.locator('[role="group"][aria-label^="3D scatter"]').focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);
  });

  await check(
    "F28 the theme toggle switches dark and light, persists, and redraws the frontier",
    async () => {
      const toLight = page.locator('button[aria-label="Switch to light theme"]');
      const toDark = page.locator('button[aria-label="Switch to dark theme"]');
      const start = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      if (config.theme === "dark") {
        await toLight.click();
        await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
      } else {
        await toDark.click();
        await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      }
      const flipped = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert(flipped !== start, `background did not change (${start})`);
      assert(
        (await page.evaluate(() => localStorage.getItem("theme"))) ===
          (config.theme === "dark" ? "light" : "dark"),
        "theme was not stored",
      );
      await page.locator('[data-frontier][data-ready="true"]').first().waitFor({ timeout: 20000 });
      // Put it back so the rest of the run matches the configuration.
      if (config.theme === "dark") await toDark.click();
      else await toLight.click();
      await page.waitForFunction((t) => document.documentElement.dataset.theme === t, config.theme);
      assert(
        (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === start,
        "the theme did not return to its starting colours",
      );
    },
  );

  await check(
    "F29 the skip link is the first stop and moves focus to the main content",
    async () => {
      await page.reload({ waitUntil: "load" });
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
      assert(focused.trim() === "Skip to content", `first Tab focused "${focused}"`);
      await page.keyboard.press("Enter");
      const hash = await page.evaluate(() => location.hash);
      assert(hash === "#main", `hash is "${hash}"`);
    },
  );

  await check("F40 the footer and the conventions note are present", async () => {
    await expectText(page.locator("footer"), "Built with Claude Code and Claude Opus 5.5.");
    await expectText(page.locator("main"), "a 252-day year");
    await expectText(page.locator("main"), "4% risk-free rate");
  });
}

async function runConfig(browser, config) {
  const contextOptions = {
    viewport: { width: config.width, height: config.height },
    hasTouch: config.phone,
  };
  const context = await browser.newContext(contextOptions);
  if (config.theme === "light") {
    await context.addInitScript(() => {
      try {
        localStorage.setItem("theme", "light");
      } catch {
        // Storage can be blocked; the page then keeps its default theme.
      }
    });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  state = { config, page, problems: [], allowNetwork: false };
  page.on("console", (message) => {
    if (message.type() === "error") state.problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => state.problems.push(`pageerror: ${error.message}`));
  state.apiRequests = 0;
  page.on("request", (request) => {
    if (request.url().startsWith(`${API}/api/portfolio`)) state.apiRequests += 1;
  });

  await page.goto(BASE, { waitUntil: "load" });
  await page.locator("#intro-title").waitFor({ state: "visible" });
  const apiBuild = (await page.locator("#holdings-file").count()) > 0;
  record(`build mode: ${apiBuild ? "risk API configured" : "no risk API configured"}`, true);

  await runCommonChecks(page, config);
  await runKeyChecks(page);
  await page.goto(BASE, { waitUntil: "load" });
  await page.locator("#intro-title").waitFor({ state: "visible" });
  await runAnalystChecks(page);
  if (apiBuild) {
    await runUploadChecks(page);
  } else {
    await runNoApiChecks(page);
  }

  await context.close();
  state = null;
}

async function main() {
  const configs = CONFIGS.filter((config) => !ONLY || config.name === ONLY);
  assert(configs.length > 0, `no configuration named ${ONLY}`);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const config of configs) {
      console.log(`--- ${config.name} (${config.width}x${config.height}, ${config.theme})`);
      await runConfig(browser, config);
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((item) => !item.ok);
  const summary = {
    base: BASE,
    api: API,
    passed: results.length - failed.length,
    failed: failed.length,
  };
  console.log(JSON.stringify(summary));
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      path.join(OUT, "functional-results.json"),
      JSON.stringify({ summary, results }, null, 2),
    );
  }
  if (failed.length > 0) {
    for (const item of failed)
      console.log(`FAILED [${item.config}] ${item.check} :: ${item.detail}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
