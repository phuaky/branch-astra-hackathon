import { handleApiRequest } from '../server';
import { sampleBrief } from '../src/coach/strategy';
import { mkdir } from 'node:fs/promises';
const out=process.argv[2]??'evidence/goal-paths/provider-report.json';
const baseUrl=process.argv[3];
const cases=[
 {name:'ready_for_next_step',turns:[['customer','We manually copy and route requests. We lose three hours every day. We need to reduce delays and keep a manual review.'],['seller','A small pilot with manual review could test the workflow and reliability.'],['customer','That fits what we need. I own the decision and can bring our operations lead. Let’s work out the scope and start a pilot.']],expected:'A concrete scoped-pilot ask or confirmation, not repetitive discovery'},
 {name:'incomplete_discovery',turns:[['seller','Thanks for taking the call.'],['customer','I am just looking around. I have not identified a problem yet.']],expected:'Understand or qualify; no premature purchase or pilot close'},
 {name:'poor_fit',turns:[['customer','We lose time routing requests manually.'],['seller','Our pilot includes manual review and a reliability check.'],['customer','We cannot use a pilot with manual review. We require certified unattended operation, and this does not fit. We do not want to proceed.']],expected:'Respect the mismatch and do not push a commitment'},
];
const results=[];
for(const fixture of cases){
 const payload={sessionId:`probe-${fixture.name}`,generation:0,topics:[],evidence:[],brief:sampleBrief,turns:fixture.turns.map(([role,text],i)=>({id:`probe-turn-${i}`,sessionId:`probe-${fixture.name}`,role,speaker:role,text,atMs:i*1000,final:true,revision:1,sourceMode:'practice'}))};
 const started=performance.now();
 const request=new Request(`${baseUrl??'http://127.0.0.1:5181'}/api/coach`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 const response=baseUrl?await fetch(request):await handleApiRequest(request);
 const body=await response.json();
 results.push({name:fixture.name,expected:fixture.expected,payload,status:response.status,elapsedMs:Math.round(performance.now()-started),response:body});
 console.log(JSON.stringify({name:fixture.name,status:response.status,provider:body.provider,direction:body.direction,suggestions:body.suggestions?.map((s:any)=>({intent:s.intent,text:s.text})),error:body.error}));
}
await mkdir(out.slice(0,out.lastIndexOf('/')),{recursive:true});
await Bun.write(out,JSON.stringify({command:'bun scripts/goal-coaching-probe.ts',at:new Date().toISOString(),baseUrl:baseUrl??'local server handler',cases:results},null,2));
if(results.some(r=>r.status!==200||r.response.provider!=='astra'||!r.response.direction||!r.response.providerResponseId))process.exitCode=1;
