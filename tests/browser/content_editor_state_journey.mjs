import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.KACHA_PLAYWRIGHT_MODULE);
const [origin, workspacePath, artifacts] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, executablePath: process.env.KACHA_CHROMIUM_EXECUTABLE || undefined });
const checks = []; const errors = [];
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
fs.mkdirSync(artifacts, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  let arrived = deferred(), release = deferred(), calls = 0, failing = false;
  await page.route('**/api/content/start', async route => {
    calls++; const body = route.request().postDataJSON(); arrived.resolve(); await release.promise;
    await route.fulfill(failing ? { status: 409, json: { error: 'fixture: 创建失败，输入已保留' } }
      : { json: { status: 'blocked', projectId: body.projectId || 'content-fixture', projectRoot: body.projectRoot } });
  });
  await page.goto(`${origin}/content`);
  await page.getByRole('button', { name: '只有选题' }).click();
  assert.equal(await page.locator('#scriptField').isHidden(), true);
  assert.equal(await page.locator('[data-mode=topic]').getAttribute('aria-pressed'), 'true');
  await page.locator('#topic').fill('如何验证自己的工作？');
  await page.locator('#projectRoot').fill('/content-a');
  assert.equal(await page.locator('#style option:disabled').count(), 5);
  await page.locator('#show').selectOption('tool-share');
  assert.equal(await page.locator('#style').inputValue(), 'xingzhe-light-overlay');
  assert.equal(await page.locator('#style option:disabled').count(), 1);
  await page.locator('#show').selectOption('ai-practice');
  await page.locator('#startContent').click(); await arrived.promise;
  for (const id of ['projectRoot', 'topic', 'chooseScript', 'show', 'style', 'startContent']) assert.equal(await page.locator(`#${id}`).isDisabled(), true);
  await page.locator('#contentForm').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  release.resolve();
  await page.locator('#contentResult:not([hidden])').waitFor();
  assert.equal(calls, 1);
  assert.match(await page.locator('#contentStatus').textContent(), /运行环境尚未就绪/);
  assert.match(await page.locator('#openProject').getAttribute('href'), /content-a/);
  assert.equal(await page.locator('#projectRoot').isDisabled(), false);
  await page.locator('#projectRoot').fill('/content-b');
  assert.equal(await page.locator('#contentResult').isHidden(), true);
  arrived = deferred(); release = deferred(); failing = true;
  await page.locator('#startContent').click(); await arrived.promise; release.resolve();
  await page.locator('#contentStatus').filter({ hasText: 'fixture' }).waitFor();
  assert.equal(await page.locator('#contentResult').isHidden(), true);
  assert.equal(await page.locator('#projectRoot').inputValue(), '/content-b');
  assert.equal(await page.locator('#startContent').isEnabled(), true);
  checks.push('content-create-lock-duplicate-rejection-target-invalidation-and-failure-recovery');
  await page.locator('#projectRoot').fill('relative');
  await page.locator('#startContent').click();
  assert.match(await page.locator('#contentStatus').textContent(), /绝对路径/);
  assert.equal(calls, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'content-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(artifacts, 'content-desktop.png'), fullPage: true });
  checks.push('content-style-compatibility-keyboard-form-and-390px-layout');

  let openArrived = deferred(), openRelease = deferred(), delayOpen = false, openCalls = 0, commands = 0;
  await page.route('**/api/editor/open', async route => {
    openCalls++;
    if (delayOpen) { const result = await route.fetch(); openArrived.resolve(); await openRelease.promise; await route.fulfill({ response: result }); }
    else await route.continue();
  });
  page.on('request', request => { if (request.url().endsWith('/api/editor/command')) commands++; });
  await page.goto(`${origin}/editor`);
  const open = async () => {
    await page.locator('#timelinePath').fill(workspacePath);
    await page.locator('#openForm button').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('已打开') && !document.querySelector('#workspace').inert);
  };
  await open();
  let previews = 0; const previewArrived = deferred(), previewRelease = deferred();
  await page.route('**/api/editor/real-preview', async route => {
    previews++; previewArrived.resolve(); await previewRelease.promise;
    await route.fulfill({ json: { status: 'succeeded', ready: true, key: 'stale-fixture' } });
  });
  await page.clock.install({ time: new Date('2026-10-07T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-07T00:00:01Z'));
  delayOpen = true;
  await page.evaluate(() => { document.querySelector('#realPreviewButton').click(); document.querySelector('#openForm').requestSubmit(); });
  await openArrived.promise;
  await page.clock.runFor(500); assert.equal(previews, 0, 'switch cancels a scheduled preview before submission');
  assert.equal(await page.locator('#workspace').evaluate(node => node.inert), true);
  assert.equal(await page.locator('#openForm').evaluate(node => node.inert), true);
  await page.locator('#markerButton').evaluate(button => button.click());
  await page.locator('#openForm').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.keyboard.press('m');
  assert.equal(commands, 0); assert.equal(openCalls, 2);
  openRelease.resolve(); delayOpen = false;
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('已打开') && !document.querySelector('#workspace').inert);
  await Promise.all([page.waitForResponse('**/api/editor/command'), page.locator('#markerButton').click()]);
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已原子写入'));
  assert.equal(commands, 1);
  await page.locator('#realPreviewButton').click(); await page.clock.runFor(400); await previewArrived.promise;
  await open();
  const oldPreviewResponse = page.waitForResponse('**/api/editor/real-preview'); previewRelease.resolve();
  await (await oldPreviewResponse).finished(); await page.clock.runFor(32);
  assert.equal(await page.locator('#realPreviewVideo').isHidden(), true);
  assert.equal(previews, 1);
  await page.clock.resume();
  checks.push('obsolete-preview-timer-cancelled-and-inflight-result-discarded');
  checks.push('open-versus-edit-race-prevented-and-new-session-remains-editable');

  const exportArrived = deferred(), exportRelease = deferred(); let exports = 0;
  await page.route('**/api/editor/delivery-plan', async route => {
    exports++; exportArrived.resolve(); await exportRelease.promise;
    await route.fulfill({ json: { status: 'pass', plan: { path: '/fixture/current-plan.json' } } });
  });
  await page.locator('#deliveryButton').click();
  await page.locator('#deliveryOutput').fill('relative-final.mp4');
  await page.locator('#deliveryPlanForm button').click();
  await page.locator('#deliveryStatus').filter({ hasText: '绝对路径' }).waitFor();
  assert.equal(exports, 0, 'UI must reject relative output before submitting');
  const headers = { Origin: origin, 'X-Kacha-Studio': '1', 'Content-Type': 'application/json' };
  const opened = await (await fetch(`${origin}/api/editor/open`, { method: 'POST', headers, body: JSON.stringify({ timelinePath: workspacePath }) })).json();
  for (const endpoint of ['delivery-plan', 'delivery-bundle', 'nle-export']) {
    const rejected = await fetch(`${origin}/api/editor/${endpoint}`, { method: 'POST', headers, body: JSON.stringify({ sessionId: opened.browserSessionId, outputPath: 'relative-final.mp4', profileId: 'wechat-channels', format: 'otio' }) });
    assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /绝对路径/);
  }
  checks.push('relative-delivery-destinations-rejected-by-ui-and-all-three-http-routes');
  await page.locator('#deliveryOutput').fill('/fixture/final.mp4');
  await page.locator('#deliveryPlanForm button').click(); await exportArrived.promise;
  await page.locator('#deliveryPlanForm').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.locator('#openForm').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.locator('#markerButton').evaluate(button => button.click());
  assert.equal(openCalls, 3); assert.equal(commands, 1);
  exportRelease.resolve();
  await page.locator('#deliveryStatus').filter({ hasText: 'current-plan.json' }).waitFor();
  assert.equal(exports, 1);
  assert.equal(await page.locator('#openForm').evaluate(node => node.inert), false);
  checks.push('delivery-write-target-lock-no-duplicate-or-concurrent-open');

  await page.locator('#timelinePath').fill('/fixture/missing-workspace.json');
  await page.locator('#openForm button').click();
  await page.locator('#workspace').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#video').getAttribute('src'), null);
  assert.equal(await page.locator('#openForm').evaluate(node => node.inert), false);
  await open();
  assert.doesNotMatch(await page.locator('#deliveryStatus').textContent(), /current-plan.json/);
  checks.push('failed-open-clears-old-editable-target-and-reopen-recovers');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['/content', '/', '/project', '/editor', '/review']) {
    await page.goto(`${origin}${route}`);
    const nav = page.getByRole('navigation', { name: '生产台页面' });
    assert.deepEqual(await nav.getByRole('link').allTextContents(), ['内容', '配置', '项目', '调整', '审片']);
    assert.equal(await nav.locator('[aria-current=page]').getAttribute('href'), route);
    for (const link of await nav.getByRole('link').all()) assert.equal(await link.isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `navigation overflow on ${route}`);
  }
  checks.push('five-page-consistent-navigation-current-state-and-mobile-layout');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(artifacts, 'content-editor-state.json'), JSON.stringify({ status: 'pass', checks }, null, 2));
  console.log(JSON.stringify({ status: 'pass', checks }, null, 2));
} finally { await browser.close(); }
