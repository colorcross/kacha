import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {runtimeDigest,inspectBundle,bindRuntime,callBoundProject} from '../scripts/runtime_bundle.mjs';
import {requestRealPreview,realPreviewStatus} from '../scripts/real_preview.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kacha-runtime-v5-'));
const previousTrust=process.env.KACHA_RUNTIME_TRUST_ROOT;process.env.KACHA_RUNTIME_TRUST_ROOT=path.join(root,'trust');
try{
 const bundle=path.join(root,'bundle'),project=path.join(root,'project');fs.mkdirSync(bundle);fs.mkdirSync(path.join(project,'.kacha'),{recursive:true});
 fs.mkdirSync(path.join(bundle,'scripts'));fs.mkdirSync(path.join(bundle,'config'));fs.writeFileSync(path.join(bundle,'SKILL.md'),'fixture');fs.writeFileSync(path.join(bundle,'scripts/kacha.mjs'),'console.log(JSON.stringify({status:"bound_fixture",argv:process.argv.slice(2)}));');fs.writeFileSync(path.join(bundle,'config/defaults.json'),'{}');
 fs.writeFileSync(path.join(bundle,'code.mjs'),'original');const digest=runtimeDigest(bundle);
 fs.writeFileSync(path.join(bundle,'.kacha-runtime.json'),JSON.stringify({kind:'kacha-frozen-runtime',sourceRef:'a'.repeat(40),sourceDirty:false,bundleDigest:digest}));
 const original=JSON.stringify({projectId:'p',runtimeLock:{sourceRef:'b'.repeat(40),bundleDigest:'c'.repeat(64)}});
 fs.writeFileSync(path.join(project,'.kacha/orchestration.json'),original);
 assert.equal(inspectBundle(bundle).productionReady,true);
 assert.throws(()=>bindRuntime(project,bundle),/accept-runtime-update/);
 const binding=bindRuntime(project,bundle,{acceptUpdate:true});assert.equal(binding.migrationRequired,true);
 assert.equal(callBoundProject(project,'status',[],bundle),null);
 const timeline=path.join(project,'timeline.json');fs.writeFileSync(timeline,'{}');
 const routed=requestRealPreview(timeline,{start:0,end:1,expectedSha256:'fixture'});
 assert.equal(routed.status,'bound_fixture');assert.deepEqual(routed.argv.slice(0,3),['real-preview','request','--timeline']);
 assert.equal(realPreviewStatus(timeline,'fixture').argv[1],'status');
 const bindingFile=path.join(project,'.kacha/runtime-binding.json');
 fs.writeFileSync(bindingFile,JSON.stringify({...binding,trustId:'0'.repeat(64)}));
 assert.throws(()=>callBoundProject(project,'status',[],bundle));
 fs.writeFileSync(bindingFile,JSON.stringify(binding));
 assert.equal(fs.readFileSync(path.join(project,'.kacha/orchestration.json'),'utf8'),original);
 fs.writeFileSync(path.join(root,'other-agent'),'changed');assert.equal(inspectBundle(bundle,digest).productionReady,true);
 fs.appendFileSync(path.join(bundle,'code.mjs'),'changed');assert.throws(()=>inspectBundle(bundle,digest),/content changed/);
 console.log(JSON.stringify({status:'pass',checks:['strong-package-identity','independent-agent','migration-explicit','old-project-preserved','local-trust-required','imported-preview-bound-runtime','tamper-blocked']}));
}finally{if(previousTrust===undefined)delete process.env.KACHA_RUNTIME_TRUST_ROOT;else process.env.KACHA_RUNTIME_TRUST_ROOT=previousTrust;fs.rmSync(root,{recursive:true,force:true});}
