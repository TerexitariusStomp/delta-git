#!/usr/bin/env node
// Screenshot pass over the live deployment for the presentation deck.
// Reads /tmp/demo-session.json {cookie, ns, repo, origin}; writes PNGs to
// docs/hackathon/video/slides/shots/.

import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";

const session = JSON.parse(readFileSync("/tmp/demo-session.json", "utf8"));
const ORIGIN = session.origin;
const NS = session.ns;
const REPO = session.repo;
const OUT = "docs/hackathon/video/slides/shots";
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  // [name, path, auth]
  ["landing-anon", "/", false],
  ["signin", "/signin", false],
  ["explore", "/explore", true],
  ["home", "/", true],
  ["repo-summary", `/${NS}/repos/${REPO}/summary`, true],
  ["repo-intents", `/${NS}/repos/${REPO}/intents`, true],
  ["repo-arena", `/${NS}/repos/${REPO}/arena`, true],
  ["repo-pipelines", `/${NS}/repos/${REPO}/pipelines`, true],
  ["dev-environments", "/dev-environments", true],
  ["agents", "/agents", true],
  ["arena-global", "/arena", true],
  ["gitops", "/gitops", true],
  ["chaos", "/chaos", true],
  ["databases", "/databases", true],
  ["supply-chain", "/supply-chain", true],
  ["overrides", "/overrides", true],
  ["admin-roles", "/admin/roles", true],
  ["api-docs", "/docs", false],
];

const browser = await chromium.launch({ channel: "chromium" });
const ctxAnon = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const ctxAuth = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await ctxAuth.addCookies([
  {
    name: session.cookie.split("=")[0],
    value: session.cookie.split("=").slice(1).join("="),
    domain: "code.widespread.fyi",
    path: "/",
    secure: true,
    sameSite: "Lax",
  },
]);

for (const [name, path, auth] of SHOTS) {
  const ctx = auth ? ctxAuth : ctxAnon;
  const page = await ctx.newPage();
  try {
    await page.goto(ORIGIN + path, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1200); // lazy chunks settle
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`${name}: ${page.url()} → ok`);
  } catch (e) {
    console.log(`${name}: FAIL ${e.message.slice(0, 120)}`);
  }
  await page.close();
}
await browser.close();
