import assert from 'node:assert/strict';
const {chromium}=await import(process.env.KACHA_PLAYWRIGHT_MODULE);
const [origin,workspacePath]=process.argv.slice(2);
const browser=await chromium.launch({headless:true,executablePath:process.env.KACHA_CHROMIUM_EXECUTABLE||undefined});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.addInitScript(()=>{const Native=window.EventSource;window.__editorEvents=[];window.EventSource=class extends Native {constructor(...args){super(...args);window.__editorEvents.push(this);}};});
  await page.goto(`${origin}/editor`);await page.locator('#timelinePath').fill(workspacePath);await page.locator('#openForm button').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('已打开')&&!document.querySelector('#workspace').inert);
  let hold=false,arrived,release,done;
  await page.route('**/api/editor/project',async route=>{
    if(!hold){await route.continue();return;} hold=false;
    const result=await route.fetch();arrived.resolve(await result.json());await release.promise;await route.fulfill({response:result});done.resolve();
  });
  const beginRefresh=async()=>{
    hold=true;arrived=deferred();release=deferred();done=deferred();
    await page.evaluate(()=>window.__editorEvents.at(-1).dispatchEvent(new MessageEvent('revision',{data:JSON.stringify({timelineSha256:'synthetic-different-revision',reason:'delayed-read-fixture'})})));
    return arrived.promise;
  };
  const finishRefresh=async expected=>{
    release.resolve();await done.promise;
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#markerLayer .marker').count(),expected.projection.editor.markers.length,'old refresh overwrote the new timeline');
    assert.equal(await page.locator('#undoButton').isEnabled(),expected.session.canUndo);
    assert.equal(await page.locator('#redoButton').isEnabled(),expected.session.canRedo);
  };
  const before=await beginRefresh();const p=before.projection;
  const frame=p.timebase.ticksPerSecond/p.timebase.framesPerSecond;let tick=frame;
  while(p.editor.markers.some(m=>m.tick===tick))tick+=frame;
  assert.ok(tick<p.durationTick);
  await page.locator('#ruler').evaluate((node,ratio)=>{const rect=node.getBoundingClientRect();node.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:rect.left+rect.width*ratio}));},tick/p.durationTick);
  let [response]=await Promise.all([page.waitForResponse('**/api/editor/command'),page.locator('#markerButton').click()]);
  assert.equal(response.status(),200);let result=await response.json();
  await page.locator('#status').filter({hasText:'已原子写入'}).waitFor();await finishRefresh(result.project);
  for(const operation of ['undo','redo']) {
    await beginRefresh();
    [response]=await Promise.all([page.waitForResponse(`**/api/editor/${operation}`),page.locator(`#${operation}Button`).click()]);
    assert.equal(response.status(),200);result=await response.json();
    await page.locator('#status').filter({hasText:operation==='undo'?'撤销':'重做'}).waitFor();await finishRefresh(result.project);
  }
  console.log(JSON.stringify({status:'pass',checks:['stale-refresh-cannot-overwrite-command','stale-refresh-cannot-overwrite-undo','stale-refresh-cannot-overwrite-redo']},null,2));
} finally {await browser.close();}
