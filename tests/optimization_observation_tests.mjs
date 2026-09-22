import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { observeProject } from '../scripts/project_observation.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kacha-observe-'));
try{
 fs.mkdirSync(path.join(root,'.kacha/jobs'),{recursive:true});
 const file=path.join(root,'.kacha/orchestration.json');fs.writeFileSync(file,JSON.stringify({projectId:'test',input:{path:path.join(root,'missing.mov')},digest:'revision1'}));
 const bytes=fs.readFileSync(file);const times=[];
 for(let i=0;i<30;i++){const start=performance.now();const r=observeProject(root);times.push(performance.now()-start);assert.equal(r.executionEligible,false);assert.equal(r.status,'observation_only');assert.equal(r.inputObservation,'missing');}
 fs.writeFileSync(path.join(root,'.kacha/jobs/broken.json'),'{');
 assert.equal(observeProject(root).warnings.length,1);assert.deepEqual(fs.readFileSync(file),bytes);
 times.sort((a,b)=>a-b);console.log(JSON.stringify({status:'pass',readOnly:true,iterations:30,p95Milliseconds:times[Math.ceil(times.length*.95)-1],evidence:'in-process synthetic observation; not CLI or media benchmark'}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
