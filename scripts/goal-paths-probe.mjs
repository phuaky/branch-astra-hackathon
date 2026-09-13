import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const out='evidence/goal-paths';await mkdir(out,{recursive:true});
const report={command:'node scripts/goal-paths-probe.mjs',at:new Date().toISOString(),checks:[],errors:[],providerCalls:0,screenshots:[],sourceHashes:Object.fromEntries(['src/App.tsx','src/state/session.ts','src/scene/ConversationTrail.tsx','src/scene/conversation-trail.css','src/coach/strategy.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage({viewport:{width:1365,height:768}});page.on('pageerror',e=>report.errors.push(e.message));
await page.route('**/api/**',r=>r.fulfill({status:r.request().url().endsWith('/status')?200:503,json:r.request().url().endsWith('/status')?{configured:false}:{error:'Isolated offline probe'}}));
const check=(name,condition,detail)=>{report.checks.push({name,pass:!!condition,detail});assert.ok(condition,name);};
const settle=async()=>{await page.waitForFunction(()=>window.__branchTrail?.cameraSettled);await page.waitForTimeout(600);};
const shot=async name=>{await page.screenshot({path:`${out}/${name}.png`});report.screenshots.push(`${out}/${name}.png`);};
try {
 await page.goto('http://127.0.0.1:5180/');await settle();
 const initial=await page.evaluate(()=>window.__branch.getSession());
 check('default view is the 3D decision map',await page.locator('.conversation-trail').isVisible());
 for(const [width,height] of [[1365,768],[1920,1080]]){
  await page.setViewportSize({width,height});await settle();
  const cards=await page.locator('.branch-option__text').evaluateAll(els=>els.map(e=>{const s=getComputedStyle(e);return{text:e.textContent,clamp:s.webkitLineClamp,height:e.clientHeight,scroll:e.scrollHeight,width:e.clientWidth,scrollWidth:e.scrollWidth,font:parseFloat(s.fontSize)};}));
  check(`all three full recommendations wrap at ${width}`,cards.length===3&&cards.every((c,i)=>c.text===initial.suggestions[i].text&&c.clamp==='none'&&c.scroll<=c.height+1&&c.scrollWidth<=c.width+1&&c.font>=16),cards);
  await shot(`full-text-${width}`);
 }
 await page.setViewportSize({width:1365,height:768});await settle();
 await page.locator('.branch-option__why').first().click();check('reasoning can be opened without choosing',await page.locator('.branch-option__reason').first().isVisible()&&!(await page.evaluate(()=>window.__branchTrail.chosenSuggestionId)));await page.locator('.branch-option__why').first().click();
 await page.locator('.branch-option__choose').first().click();await settle();
 const chosen=await page.evaluate(()=>({scene:window.__branchTrail,session:window.__branch.getSession()}));
 check('choice lights rendered 3D geometry and card',chosen.scene.chosenPathMeshes===2&&chosen.scene.chosenSuggestionId===initial.suggestions[0].id&&await page.locator('.branch-option.is-chosen').count()===1&&await page.locator('.trail-branch-tethers path.is-chosen').count()===1,chosen.scene);
 check('unchosen alternatives remain dashed and actionable',await page.locator('.branch-option:not(.is-chosen) .branch-option__choose:enabled').count()===2&&await page.locator('.trail-branch-tethers path:not(.is-chosen)').count()===2);
 check('choosing does not fabricate a spoken exchange',JSON.stringify(chosen.session.turns)===JSON.stringify(initial.turns));
 await page.waitForTimeout(3000);await shot('chosen-path');
 await page.getByRole('button',{name:'Next exchange',exact:true}).click();await page.waitForFunction(n=>window.__branch.getSession().turns.filter(t=>t.final).length>n,initial.turns.filter(t=>t.final).length);await settle();
 await page.getByLabel('Revisit saved paths').selectOption(chosen.scene.decisionTurnId);await settle();
 check('later playback can reopen the exact chosen snapshot',await page.evaluate(id=>window.__branchTrail.chosenSuggestionId===id,initial.suggestions[0].id));
 check('historical alternatives retain full wording',JSON.stringify(await page.locator('.branch-option__text').allTextContents())===JSON.stringify(initial.suggestions.map(s=>s.text)));
 await shot('revisited-alternatives');
 const beforeFork=await page.evaluate(()=>window.__branch.getSession());
 await page.locator('.branch-option__choose:enabled').first().click();await settle();
 const bundle=await page.evaluate(()=>JSON.parse(window.__branch.getExport()));
 check('historical alternative opens a separate practice with the selected wording',bundle.session.mode==='practice'&&bundle.session.id!==beforeFork.id&&bundle.session.fork.throughTurnId===chosen.scene.decisionTurnId&&await page.getByLabel('Add a typed turn').inputValue()===initial.suggestions[1].text);
 const archived=bundle.originals.find(s=>s.id===beforeFork.id);
 check('original choice and later speech remain intact',JSON.stringify(archived.turns)===JSON.stringify(beforeFork.turns)&&JSON.stringify(archived.decisions)===JSON.stringify(beforeFork.decisions));
 check('practice begins at the selected prefix and retains all alternatives',bundle.session.turns.at(-1).id===chosen.scene.decisionTurnId&&bundle.session.decisions.at(-1).suggestions.length===3&&bundle.session.decisions.at(-1).chosenSuggestionId===initial.suggestions[1].id);
 await page.getByRole('button',{name:'Return to original attempt',exact:true}).click();await settle();
 check('return restores the original choice',await page.evaluate(id=>window.__branch.getSession().decisions.find(d=>d.throughTurnId===id).chosenSuggestionId,chosen.scene.decisionTurnId)===initial.suggestions[0].id);
 await page.getByRole('button',{name:'Call brief',exact:true}).click();
 const fields={'Call goal':'Book a workflow demo','What you offer':'A routing workflow pilot.','Who it fits':'Operations teams','Pricing and terms':'Scope before quoting','Limits and things to verify':'No untested reliability guarantees'};
 for(const [label,value] of Object.entries(fields))await page.getByLabel(label,{exact:true}).fill(value);
 await page.getByRole('button',{name:'Save call brief',exact:true}).click();await page.waitForFunction(()=>window.__branch.getSession().guidanceStatus==='ready');
 const brief=await page.evaluate(()=>window.__branch.getSession().brief);
 check('brief editor saves goal, offer, fit, pricing and constraints',JSON.stringify(Object.values(brief))===JSON.stringify(Object.values(fields)),brief);
 const long=structuredClone(initial);const longText='Could you walk me through who would approve a pilot, which workflow we should start with, and the result your team would need to see before deciding whether to continue? I want us to agree on a specific outcome and a practical next action, with the owner and timing clear, while leaving room to stop if the pilot does not meet your requirements.';
 long.suggestions=long.suggestions.map(s=>({...s,text:longText}));long.decisions.at(-1).suggestions=structuredClone(long.suggestions);
 await page.evaluate(s=>window.__branch.loadSession(s),long);await settle();
 for(const [width,height] of [[1365,768],[1920,1080],[390,844]]){
  await page.setViewportSize({width,height});await settle();
  for(let i=0;i<3;i++){
   const el=page.locator('.branch-option__text').nth(i);await el.scrollIntoViewIfNeeded();
   check(`full long recommendation ${i+1} reachable at ${width}`,await el.isVisible()&&await el.textContent()===longText&&await el.evaluate(e=>e.clientWidth>=280&&e.scrollHeight<=e.clientHeight+1&&e.scrollWidth<=e.clientWidth+1&&getComputedStyle(e).webkitLineClamp==='none'));
  }
  check(`no horizontal page overflow at ${width}`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await shot(`long-text-${width}`);
 }
 await page.setViewportSize({width:1365,height:768});await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await settle();await page.locator('.branch-option__choose').first().click();await settle();
 check('reduced motion retains selection and full text',await page.evaluate(()=>window.__branchTrail.chosenPathMeshes===2)&&await page.locator('.branch-option__text').count()===3);
 check('no browser exceptions',report.errors.length===0,report.errors);report.status='passed';
}catch(e){report.status='failed';report.failure=e.stack;await shot('failure');process.exitCode=1;}finally{await browser.close();await writeFile(`${out}/browser-report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:report.checks.length,failures:report.checks.filter(c=>!c.pass),failure:report.failure,errors:report.errors},null,2));}
