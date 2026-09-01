#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const modulePath = process.env.KACHA_PLAYWRIGHT_MODULE;
const origin = process.argv[2];
const workspacePath = process.argv[3];
const artifactDirectory = process.argv[4];
if (!modulePath || !origin || !workspacePath || !artifactDirectory) {
  throw new Error("usage: KACHA_PLAYWRIGHT_MODULE=... node editor_v3_journey.mjs ORIGIN WORKSPACE ARTIFACT_DIR");
}
const { chromium } = await import(modulePath);
fs.mkdirSync(artifactDirectory, { recursive: true });
const executablePath = process.env.KACHA_CHROMIUM_EXECUTABLE || undefined;
const browser = await chromium.launch({ headless: true, executablePath });
const errors = [];
const checks = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console:${message.text()}`); });
  await page.goto(`${origin}/editor`, { waitUntil: "networkidle" });
  await page.locator("#timelinePath").fill(workspacePath);
  await page.locator("#openForm button[type=submit]").click();
  await page.locator("#workspace:not([hidden])").waitFor();
  await page.locator("#timelineSwitcher:not([disabled])").waitFor();
  checks.push({ id: "workspace-open", status: "pass", options: await page.locator("#timelineSwitcher option").count() });

  await page.locator("#capabilitiesButton").click();
  await page.locator("#capabilityDrawer:not([hidden])").waitFor();
  await page.locator(".capability-card").first().waitFor({ state: "attached" });
  const capabilityCards = await page.locator(".capability-card").count();
  const planned = await page.locator(".status-pill.planned").count();
  const firstEvidence = await page.locator(".capability-evidence").first().textContent();
  if (capabilityCards < 12 || planned < 1 || !firstEvidence?.includes("证据：")) throw new Error("capability map did not expose status and implementation evidence");
  checks.push({ id: "capability-map", status: "pass", capabilityCards, planned, firstEvidence });

  await page.locator("#deliveryButton").click();
  await page.locator("#deliveryDrawer:not([hidden])").waitFor();
  if (!(await page.locator("#capabilityDrawer").evaluate((element) => element.hidden))) throw new Error("capability and delivery drawers remained open together");
  if (await page.locator("#deliveryProfile option").count() !== 3) throw new Error("delivery center did not expose three closed profiles");
  const deliveryOutput = path.join(artifactDirectory, "browser-final.mp4");
  await page.locator("#deliveryOutput").fill(deliveryOutput);
  await page.locator("#deliveryPlanForm button[type=submit]").click();
  await page.locator("#deliveryStatus").filter({ hasText: "还未渲染成片" }).waitFor();
  if (fs.existsSync(deliveryOutput) || !fs.existsSync(`${deliveryOutput}.kacha-delivery.json`)) throw new Error("browser delivery plan was confused with rendered media");
  checks.push({ id: "delivery-plan", status: "pass" });

  await page.locator("#activityButton").click();
  await page.locator("#activityDrawer:not([hidden])").waitFor();
  if (!(await page.locator("#deliveryDrawer").evaluate((element) => element.hidden))) throw new Error("delivery and activity drawers remained open together");
  checks.push({ id: "agent-activity", status: "pass" });

  await page.locator("#duplicateTimelineButton").click();
  await page.locator("#duplicateDialog[open]").waitFor();
  await page.locator("#duplicateId").fill("browser-vertical");
  await page.locator("#duplicateLabel").fill("Browser Vertical");
  await page.locator("#duplicatePath").fill("versions/browser-vertical.json");
  await page.locator("#duplicateWidth").fill("1080");
  await page.locator("#duplicateHeight").fill("1920");
  await page.locator("#duplicateRole").selectOption("aspect");
  await page.locator("#duplicateForm button[type=submit]").click();
  await page.locator("#timelineSwitcher option").nth(1).waitFor({ state: "attached" });
  if (await page.locator("#timelineSwitcher").inputValue() !== "browser-vertical") throw new Error("duplicated timeline was not opened as the active candidate");
  checks.push({ id: "timeline-duplicate-switch", status: "pass" });

  await page.screenshot({ path: path.join(artifactDirectory, "editor-v3-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#timelinePath").fill(workspacePath);
  await page.locator("#openForm button[type=submit]").click();
  await page.locator("#workspace:not([hidden])").waitFor();
  await page.locator("#capabilitiesButton:not([disabled])").waitFor();
  await page.locator("#capabilitiesButton").click();
  await page.locator("#capabilityDrawer:not([hidden])").waitFor();
  const mobileDrawer = await page.locator("#capabilityDrawer").boundingBox();
  if (!mobileDrawer || mobileDrawer.height > 844 * 0.74) throw new Error("390px capability drawer displaced the full workbench instead of scrolling internally");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(`390px document overflowed by ${overflow}px`);
  if (!(await page.locator("#timelineViewport").isVisible()) || !(await page.locator(".capability-card").first().isVisible())) {
    throw new Error("390px full workbench or capability evidence is not visible");
  }
  await page.screenshot({ path: path.join(artifactDirectory, "editor-v3-mobile.png"), fullPage: true });
  checks.push({ id: "mobile-390-full-workbench", status: "pass", overflow, drawerHeight: Math.round(mobileDrawer.height) });
} finally {
  await browser.close();
}
if (errors.length) throw new Error(`browser emitted errors: ${errors.join(" | ")}`);
const report = {
  schemaVersion: "1.0", kind: "kacha-editor-v3-browser-evidence", status: "pass",
  observedAt: new Date().toISOString(), origin, workspacePath, checks, errors,
  limitations: ["headless Chromium local evidence", "not creator normal-speed acceptance", "not final render or target NLE application evidence"],
};
fs.writeFileSync(path.join(artifactDirectory, "editor-v3-browser-evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
