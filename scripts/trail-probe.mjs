import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const out='evidence/trail';
await mkdir(out,{recursive:true});
const report={command:'node scripts/trail-probe.mjs',at:new Date().toISOString(),checks:[],errors:[],providerCalls:0,screenshots:[],sourceHashes:Object.fromEntries(['src/scene/trail.ts','src/scene/ConversationTrail.tsx','src/scene/conversation-trail.css','src/App.tsx','src/styles/app.css'].map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]))};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-timer-throttling']});
const page=await browser.newPage({viewport:{width:1365,height:768},recordVideo:{dir:`${out}/video`,size:{width:1365,height:768}}});
const video=page.video();
page.on('pageerror',error=>report.errors.push(error.message));
await page.route('**/api/**',route=>route.fulfill({status:route.request().url().endsWith('/status')?200:503,json:route.request().url().endsWith('/status')?{configured:false}:{error:'Isolated local probe'}}));
async function check(name,condition,detail){report.checks.push({name,pass:Boolean(condition),detail});assert.ok(condition,name);}
async function settled(){await page.waitForFunction(()=>window.__branchTrail?.cameraSettled && window.__branchScene?.visibleLabels.length>0);}
async function shot(name){await page.screenshot({path:`${out}/${name}.png`});report.screenshots.push(`${out}/${name}.png`);}
async function labels(){return page.evaluate(()=>{
 const heading=document.querySelector('.trail-heading').getBoundingClientRect();
 const scene=document.querySelector('.conversation-trail').getBoundingClientRect();
 const list=[...document.querySelectorAll('[data-scene-label]')].map(element=>({element,style:getComputedStyle(element),rect:element.getBoundingClientRect()})).filter(({style,rect})=>Number(style.opacity)>.5&&style.visibility==='visible'&&rect.width>0).map(({element,rect})=>({id:element.dataset.sceneLabel,kind:element.dataset.labelKind,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,fontSizes:[...element.querySelectorAll('span')].map(span=>parseFloat(getComputedStyle(span).fontSize))}));
 const overlaps=[];
 for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){const a=list[i],b=list[j];if(a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom)overlaps.push([a.id,b.id]);}
 return {list,overlaps,headingClear:list.every(a=>a.left>=heading.right||a.right<=heading.left||a.top>=heading.bottom||a.bottom<=heading.top),withinScene:list.every(a=>a.left>=scene.left&&a.right<=scene.right&&a.top>=scene.top&&a.bottom<=scene.bottom)};
});}
function stress(original,count=1000){
 const session=structuredClone(original);session.id='trail-stress';session.generation=1;session.coachHistory=[];session.mapHistory=[];session.decisions=[];session.guidanceStatus='ready';session.provider='recorded';
 session.topics=Array.from({length:30},(_,i)=>({id:`topic-${i}`,key:`topic-${i}`,label:['Workflow','Impact','Reliability','Decision criteria','Next steps'][i%5]+` ${Math.floor(i/5)+1}`,summary:'Synthetic scene fixture',turnIds:[],position:[i,Math.sin(i),i*.4],createdAtTurnId:`turn-${i}`,createdAt:i}));
 session.turns=Array.from({length:count},(_,i)=>({id:`turn-${i}`,sessionId:session.id,speaker:i%2?'Customer':'Seller',role:i%2?'customer':'seller',text:`Synthetic exchange ${i+1}. What would a useful outcome look like?`,atMs:i*1500,revision:0,final:true,sourceMode:i>990&&i%2===0?'practice':'replay'}));
 session.turnTopics=Object.fromEntries(session.turns.map((turn,i)=>[turn.id,session.topics[i%30].id]));
 for(const turn of session.turns)session.topics.find(t=>t.id===session.turnTopics[turn.id]).turnIds.push(turn.id);
 session.activeTopicId=session.turnTopics[session.turns.at(-1).id];session.analyzedThroughTurnId=session.turns.at(-1).id;
 session.suggestions=original.suggestions.map((s,i)=>({...s,id:`stress-suggestion-${i}`,topicId:session.activeTopicId,turnIds:[session.turns.at(-1).id]}));
 return session;
}
try{
 await page.goto('http://127.0.0.1:5180/?view=map');await settled();
 const initial=await page.evaluate(()=>window.__branch.getSession());
 await check('map opens directly in Focus',await page.locator('.conversation-trail').getAttribute('data-view')==='focus');
 const initialTrail=await page.evaluate(()=>window.__branchTrail);
 const points=initialTrail.visits.slice(0,4).map(v=>v.position);
 const [u,v,w]=points.slice(1).map(p=>p.map((n,i)=>n-points[0][i]));
 const determinant=Math.abs(u[0]*(v[1]*w[2]-v[2]*w[1])-u[1]*(v[0]*w[2]-v[2]*w[0])+u[2]*(v[0]*w[1]-v[1]*w[0]));
 await check('rendered visit positions are noncoplanar in a perspective scene',determinant>.001&&await page.evaluate(()=>window.__branchScene.projection==='perspective'),{determinant,points});
 await check('real sample preserves its return to Workflow',initialTrail.visits.length===4&&initialTrail.visits[2].returning,initialTrail.visits);
 report.labels={};
 for(const [width,height] of [[1365,768],[1920,1080]]){
  await page.setViewportSize({width,height});await settled();
  const result=await labels();report.labels[`${width}x${height}`]=result;
  await check(`Focus has current exchange and all three questions at ${width}`,result.list.some(x=>x.kind==='turn')&&await page.locator('.branch-option').count()===3,result);
  await check(`Focus labels do not overlap or clip at ${width}`,result.overlaps.length===0&&result.headingClear&&result.withinScene&&result.list.every(x=>x.fontSizes.every(size=>size>=16)),result);
  await shot(`focus-${width}`);
 }
 const question=page.locator('.branch-option.is-recommended');await question.locator('.branch-option__why').click();
 await check('question expands its rationale',await question.locator('.branch-option__reason').isVisible());
 await question.locator('.branch-option__why').click();
 await page.getByRole('button',{name:'Related source',exact:true}).click();
 await check('related source opens exact source passage',await page.getByRole('dialog').isVisible()&&await page.getByRole('dialog').innerText().then(text=>text.includes(initial.evidence.find(e=>e.id===initial.evidenceId).passage)));
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.getByRole('button',{name:'Previous moment',exact:true}).click();await settled();
 const selected=await page.evaluate(()=>({scene:window.__branchTrail,selected:document.querySelector('.transcript-turn.selected')?.id}));
 await check('previous moment selects its exact transcript exchange',selected.scene.focusedVisitId===initialTrail.visits[2].id&&selected.selected===`turn-${initialTrail.visits[2].turnIds.at(-1)}`,selected);
 await check('historical moment restores only its saved suggestions',await page.evaluate(()=>{const d=window.__branch.getSession().decisions.find(d=>d.throughTurnId===window.__branchTrail.decisionTurnId);return [...document.querySelectorAll('.branch-option')].every(e=>d?.suggestions.some(s=>s.id===e.dataset.suggestionId));}));
 await page.getByLabel('Jump to conversation moment').selectOption(initialTrail.visits[0].id);await settled();
 await check('revisited topic can select its original occurrence',await page.evaluate(()=>window.__branchTrail.focusedVisitId)===initialTrail.visits[0].id);
 await shot('selected-history');
 await page.getByRole('button',{name:'Return to playback',exact:true}).click();await settled();
 await check('return restores current moment and follow',await page.evaluate(()=>window.__branchScene.following&&window.__branchTrail.focusedVisitId===window.__branchTrail.visits.at(-1).id));
 await page.getByRole('button',{name:'Coach & evidence',exact:true}).click();
 await check('coach and evidence remain accessible',await page.locator('.coach-panel').isVisible());
 await page.getByRole('button',{name:'Close coach',exact:true}).click();
 await page.getByRole('button',{name:'Overview',exact:true}).click();await settled();
 await check('Overview fits the entire short trail',await page.evaluate(()=>window.__branchTrail.renderedVisits===window.__branchTrail.visits.length));
 await shot('overview');
 await page.getByRole('button',{name:'Focus',exact:true}).click();await settled();
 const canvas=page.locator('canvas');
 const point=await canvas.evaluate(element=>{const r=element.getBoundingClientRect();for(const fy of [.74,.66,.56])for(const fx of [.2,.4,.6]){const x=r.left+r.width*fx,y=r.top+r.height*fy;if(document.elementFromPoint(x,y)===element)return{x,y};}throw Error('No clear canvas point');});
 const before=await page.evaluate(()=>window.__branchScene.camera.position);
 await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+90,point.y-30,{steps:8});await page.mouse.up();await page.waitForTimeout(700);
 const panned=await page.evaluate(()=>({camera:window.__branchScene.camera.position,manual:window.__branchScene.manuallyExploring,follow:window.__branchScene.following}));
 await check('drag pans and suspends follow',panned.manual&&!panned.follow&&Math.hypot(...panned.camera.map((v,i)=>v-before[i]))>.1,panned);
 await page.mouse.wheel(0,-260);await page.waitForTimeout(700);
 const zoomed=await page.evaluate(()=>window.__branchScene.camera.position);
 await check('scroll changes viewing distance',Math.hypot(...zoomed.map((v,i)=>v-panned.camera[i]))>.1);
 const changed=structuredClone(initial);changed.activeTopicId=changed.topics[0].id;
 await page.evaluate(session=>window.__branch.loadSession(session),changed);await page.waitForTimeout(400);
 await check('new state does not move manually explored camera',await page.evaluate(previous=>Math.hypot(...window.__branchScene.camera.position.map((v,i)=>v-previous[i]))<.08,zoomed));
 await page.getByRole('button',{name:'Return to playback',exact:true}).click();await settled();
 const longer=structuredClone(initial);const turn={...longer.turns.at(-1),id:'new-objection-turn',text:'The team needs approval before changing this workflow.',atMs:99999,final:true};
 longer.turns.push(turn);longer.topics.push({id:'new-objection',key:'approval',label:'Approval',summary:turn.text,turnIds:[turn.id],position:[21,4,8],createdAtTurnId:turn.id,createdAt:turn.atMs});longer.turnTopics[turn.id]='new-objection';longer.activeTopicId='new-objection';longer.suggestions=[];
 const receivedAt=await page.evaluate(session=>{const at=performance.now();window.__branch.loadSession(session);return at;},longer);
 await page.waitForFunction(()=>window.__branchScene.marks.some(m=>m.topicId==='new-objection'&&m.name.endsWith(':settled')));
 const animation=await page.evaluate(()=>window.__branchScene.marks.filter(m=>m.topicId==='new-objection'));
 const start=animation.find(m=>m.name.endsWith(':start')),end=animation.find(m=>m.name.endsWith(':settled'));
 report.animation={acceptedToStart:start.at-receivedAt,animationMs:end.at-start.at,marks:animation};
 await check('new topic draws one branch within the timing budget',animation.filter(m=>m.name.endsWith(':start')).length===1&&start.at-receivedAt<=250&&end.at-start.at<=800,report.animation);
 const after=await page.evaluate(()=>window.__branchTrail.visits);
 await check('adding a branch preserves all previous visit positions',initialTrail.visits.every((v,i)=>JSON.stringify(v.position)===JSON.stringify(after[i].position)));
 await page.setViewportSize({width:1365,height:768});
 const synthetic=stress(initial);await page.evaluate(session=>window.__branch.loadSession(session),synthetic);await settled();
 await check('1000-turn call retains complete history and bounded Focus',await page.evaluate(()=>window.__branchTrail.visits.length===1000&&window.__branchTrail.renderedVisits===3&&window.__branch.getSession().turns.length===1000));
 const stressLabels=await labels();await check('long-call Focus retains readable current exchange and next branches',stressLabels.list.some(x=>x.kind==='turn')&&await page.locator('.branch-option').count()===3&&stressLabels.overlaps.length===0&&stressLabels.headingClear,stressLabels);
 await shot('stress-focus');
 await page.getByRole('button',{name:'Overview',exact:true}).click();await settled();
 await check('long-call Overview bounds objects and retains endpoints',await page.evaluate(()=>window.__branchTrail.renderedVisits<=160&&window.__branchTrail.visits.length===1000));
 await shot('stress-overview');
 await page.getByRole('button',{name:'Focus',exact:true}).click();await settled();
 const styles=await page.evaluate(()=>window.__branchScene.pathStyles);
 await check('practice and suggested paths use distinct stroke patterns',styles.actual?.dashed===false&&styles.practice?.dashed&&styles.suggested?.dashed&&styles.practice.dashSize!==styles.suggested.dashSize,styles);
 await page.evaluate(()=>window.__branchScene.frameIntervals.length=0);
 const perfStart=Date.now();
 for(let i=0;i<30;i++){await page.mouse.move(point.x,point.y);await page.mouse.wheel(0,i%2?12:-12);await page.waitForTimeout(1000);}
 const frames=await page.evaluate(()=>window.__branchScene.frameIntervals);
 const sorted=[...frames].sort((a,b)=>a-b);report.performance={durationMs:Date.now()-perfStart,samples:frames.length,p95:sorted[Math.ceil(sorted.length*.95)-1],max:Math.max(...frames),allIntervals:frames};
 await check('30-second navigation meets 33.4ms p95',report.performance.durationMs>=30000&&frames.length>500&&report.performance.p95<=33.4001,{...report.performance,allIntervals:undefined});
 await page.getByRole('button',{name:'Simple view',exact:true}).click();
 await check('switching to Simple view disposes the renderer',await page.locator('canvas').count()===0&&await page.evaluate(()=>!window.__branchScene));
 await check('no browser exceptions',report.errors.length===0,report.errors);
 report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;await shot('failure');process.exitCode=1;}finally{await browser.close();report.video=await video.path();await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:report.checks.length,failures:report.checks.filter(c=>!c.pass),failure:report.failure,errors:report.errors,animation:report.animation,performance:report.performance?{...report.performance,allIntervals:undefined}:undefined},null,2));}
