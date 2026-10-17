import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const { chromium }=await import(process.env.KACHA_PLAYWRIGHT_MODULE);
const [origin,artifacts]=process.argv.slice(2);
const browser=await chromium.launch({headless:true,executablePath:process.env.KACHA_CHROMIUM_EXECUTABLE||undefined});
const checks=[],errors=[];fs.mkdirSync(artifacts,{recursive:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 let delayed,slow=false,statusCalls=0;
 const base={status:'rendered_requires_review',ready:true,package:'/fixture/one',digest:'a'.repeat(64),spec:{recipe:'comparison',pack:'generic',title:'Same content comparison',items:[{label:'Before',detail:'Original input'},{label:'After',detail:'Reviewed input'}],evidence:'Synthetic test',durationSeconds:8,fps:25,width:1280,height:720},entries:[{id:'overview',name:'全局并列',video:{sha256:'b'.repeat(64)}},{id:'guided',name:'逐项聚焦',video:{sha256:'c'.repeat(64)}}],selection:null};
 let state=structuredClone(base);
 await page.route('**/api/samples/media?**',route=>route.fulfill({status:404,body:'fixture media absent'}));
 await page.route('**/api/samples/status',async route=>{statusCalls++;if(slow)await new Promise(r=>{delayed=r;});await route.fulfill({json:state});});
 await page.route('**/api/samples/select',route=>{const b=route.request().postDataJSON();assert.equal(b.expectedDigest,state.digest);assert.equal(b.expectedSelection,state.selection?.digest??null);state={...state,selection:{digest:'d'.repeat(64),variant:b.variant,reason:b.reason}};return route.fulfill({json:state});});
 await page.goto(`${origin}/samples`);
 await page.locator('#package').fill('/fixture/one');await page.locator('#open').click();await page.locator('#comparison:not([hidden])').waitFor();
 assert.equal(await page.locator('#candidates video').count(),2);
 await page.locator('#selectionReason').fill('Keep comparison visible');await page.getByRole('button',{name:'选择此方向'}).first().focus();await page.keyboard.press('Enter');await page.locator('#selected').filter({hasText:'已保存'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'已选方向'}).getAttribute('aria-pressed'),'true');checks.push('keyboard-selection-persists-version-and-reason');
 await page.locator('#sampleTitle').fill('Changed content');assert.equal(await page.locator('#comparison').isHidden(),true);
 await page.locator('#open').click();await page.locator('#comparison:not([hidden])').waitFor();assert.equal(await page.locator('#sampleTitle').inputValue(),base.spec.title);checks.push('editing-clears-old-choice-and-reopen-restores-package');
 slow=true;await page.locator('#open').click();while(!delayed)await new Promise(r=>setTimeout(r,20));await page.locator('#package').fill('/fixture/two');delayed();await page.waitForTimeout(250);assert.equal(await page.locator('#comparison').isHidden(),true);checks.push('late-open-response-cannot-overwrite-new-target');slow=false;
 await page.unroute('**/api/samples/status');await page.route('**/api/samples/status',r=>r.fulfill({status:409,json:{error:'候选已改变'}}));await page.locator('#open').click();await page.locator('#sampleStatus.error').waitFor();assert.equal(await page.locator('#comparison').isHidden(),true);checks.push('failed-reopen-keeps-stale-candidates-unavailable');
 await page.unroute('**/api/samples/status');await page.route('**/api/samples/status',r=>r.fulfill({json:state}));await page.locator('#package').fill('/fixture/one');await page.locator('#open').click();await page.locator('#comparison:not([hidden])').waitFor();
 await page.screenshot({path:path.join(artifacts,'samples-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(artifacts,'samples-mobile.png'),fullPage:true});
 checks.push('desktop-and-mobile-comparison-no-overflow');assert.deepEqual(errors,[]);fs.writeFileSync(path.join(artifacts,'samples-journey.json'),JSON.stringify({status:'pass',checks,statusCalls},null,2));console.log(JSON.stringify({status:'pass',checks}));
}finally{await browser.close();}
