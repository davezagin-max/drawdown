#!/usr/bin/env node
/**
 * Captures README screenshots (and an optional demo GIF) with headless Chromium.
 *
 *   pnpm build && pnpm screenshots
 *
 * Reads screenshots.json:
 *   {
 *     "shots": [
 *       { "name": "hero", "path": "/", "theme": "light", "viewport": "desktop",
 *         "actions": [{ "click": "text=Run" }, { "waitFor": "#result" }, { "wait": 400 }] }
 *     ],
 *     "gif": { "path": "/", "theme": "dark", "actions": [ ... ] }
 *   }
 * Actions: click, fill ([selector, text]), press, hover, waitFor (selector), wait (ms), scroll (px).
 * The gif block also takes "viewport", "fps", "width", "colors", "dither", and "keepColors".
 * Output goes to docs/<name>.png and docs/demo.gif. The GIF needs ffmpeg on PATH.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const config = JSON.parse(readFileSync("screenshots.json", "utf8"));
const port = config.port ?? 3210;
const base = `http://localhost:${port}`;
const out = "docs";
mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};

const server = spawn("pnpm", ["exec", "next", "start", "-p", String(port)], {
  stdio: "ignore",
  detached: true,
});
const stop = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stop);

for (let i = 0; ; i++) {
  try {
    await fetch(base);
    break;
  } catch {
    if (i > 80) throw new Error("Server did not start. Run `pnpm build` first.");
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function perform(page, actions = []) {
  for (const action of actions) {
    if (action.click) await page.click(action.click);
    else if (action.fill) await page.fill(action.fill[0], action.fill[1]);
    else if (action.press) await page.keyboard.press(action.press);
    else if (action.hover) await page.hover(action.hover);
    else if (action.waitFor) await page.waitForSelector(action.waitFor, { timeout: 20_000 });
    else if (action.wait) await page.waitForTimeout(action.wait);
    else if (action.scroll) await page.mouse.wheel(0, action.scroll);
  }
}

async function open(browser, spec, extra = {}) {
  // A named size, or an explicit { width, height } for a shot that needs more room.
  const viewport =
    typeof spec.viewport === "object" ? spec.viewport : VIEWPORTS[spec.viewport ?? "desktop"];
  const theme = spec.theme ?? "light";
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: spec.motion ? "no-preference" : "reduce",
    ...extra,
  });
  await context.addInitScript((t) => {
    try {
      localStorage.setItem("theme", t);
    } catch {}
  }, theme);
  const page = await context.newPage();
  await page.goto(base + (spec.path ?? "/"), { waitUntil: "networkidle" });
  return { context, page, viewport };
}

const browser = await chromium.launch();
try {
  for (const shot of config.shots ?? []) {
    const { context, page } = await open(browser, shot);
    await perform(page, shot.actions);
    const file = path.join(out, `${shot.name}.png`);
    await page.screenshot({ path: file, fullPage: Boolean(shot.fullPage) });
    await context.close();
    console.log(`wrote ${file}`);
  }

  if (config.gif) {
    const videoDir = path.join(out, ".video");
    const size =
      typeof config.gif.viewport === "object"
        ? config.gif.viewport
        : VIEWPORTS[config.gif.viewport ?? "desktop"];
    const { context, page } = await open(
      browser,
      { ...config.gif, motion: true },
      { deviceScaleFactor: 1, recordVideo: { dir: videoDir, size } },
    );
    await perform(page, config.gif.actions);
    await page.waitForTimeout(600);
    const video = await page.video().path();
    await context.close();
    const gif = path.join(out, "demo.gif");
    // Optional size controls: "fps", "width", "colors", "dither". The recording is lossy, so
    // near-identical frames are dropped first (mpdecimate); after that only the changed
    // rectangle of each frame is re-encoded, which keeps a mostly still UI small.
    // "keepColors" lists [from, to] pairs whose gradient must survive the shared palette:
    // a small but important color (a red warning) is otherwise outvoted by the rest.
    const { fps = 12, width = 800, colors = 128, dither = "bayer", keepColors = [] } = config.gif;
    const height = Math.round((size.height * width) / size.width / 2) * 2;
    const swatches = keepColors.map(
      ([from, to], i) =>
        `gradients=s=${width}x${height}:c0=${from.replace("#", "0x")}:c1=${to.replace("#", "0x")}:x0=0:y0=0:x1=${width - 1}:y1=0:nb_colors=2:speed=0:r=${fps}:d=0.5,setsar=1,format=rgb24[k${i}]`,
    );
    const paletteInputs = ["[pal]", ...keepColors.map((_, i) => `[k${i}]`)].join("");
    const graph = [
      `[0:v]scale=${width}:${height}:flags=lanczos,setsar=1,mpdecimate,fps=${fps},format=rgb24,split=2[pal][frames]`,
      ...swatches,
      `${paletteInputs}concat=n=${keepColors.length + 1}:v=1,palettegen=max_colors=${colors}[p]`,
      `[frames][p]paletteuse=dither=${dither}:diff_mode=rectangle`,
    ].join(";");
    try {
      execFileSync("ffmpeg", ["-y", "-i", video, "-filter_complex", graph, gif], {
        stdio: "ignore",
      });
      console.log(`wrote ${gif}`);
    } catch {
      console.warn("ffmpeg not available: skipped docs/demo.gif (add it to the manual checklist).");
    }
    rmSync(videoDir, { recursive: true, force: true });
  }
} finally {
  await browser.close();
  stop();
}
