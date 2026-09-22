import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { firstFinite, extractUsage, tokenEvidence, accountingEvents, ledgerAccounting } from '../scripts/telemetry_usage.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assert.equal(firstFinite(null,undefined,'',false,true,{},-1),null);
assert.equal(firstFinite(null,'',0,12),0);
assert.equal(extractUsage({usage:{input_tokens:null,prompt_tokens:125,output_tokens:20}}).input,125);
assert.equal(extractUsage({usage:{input_tokens:null,output_tokens:null}}),null);
assert.equal(extractUsage({usage:{reference_tokens:8}}).references,8);
assert.deepEqual(extractUsage({usage:{input_tokens:3},result:{usage:{output_tokens:4}}}),{input:3,output:4,references:null});
const cash=ledgerAccounting([{cost:{ledger:'ledger',entries:['paid','pending']}},{cost:{ledger:'ledger',entries:['paid']}}],()=>({kind:'kacha-cost-ledger',currency:'CNY',entries:[{id:'paid',status:'refunded',actualAmount:10,refundAmount:2},{id:'pending',status:'reconciliation_required'}]}));
assert.equal(cash.reconciledTotalsByCurrency.CNY,8);assert.equal(cash.entries.length,2);assert.equal(cash.complete,false);assert.equal(cash.entries[1].amount,null);
const mixed=tokenEvidence({usage:{input:12,output:0},estimate:4});
assert.equal(mixed.measurement,'mixed');assert.equal(mixed.fields.references.measurement,'estimated');assert.equal(mixed.output,0);
const events=[{eventId:'p',timing:{startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:00:10Z',wallSeconds:10}},
 {eventId:'a',parentEventId:'p',timing:{wallSeconds:7}}, {eventId:'b',parentEventId:'p',timing:{wallSeconds:6}}];
const summary=accountingEvents([...events,events[1]]);
assert.equal(summary.duplicateEvents,1);assert.equal(summary.timing.taskSeconds,13);assert.equal(summary.timing.elapsedSeconds,10);assert.equal(summary.usage.length,2);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kacha-telemetry-v5-'));
try {
 const script=path.join(repo,'scripts/run_telemetry.mjs');
 const run=(args)=>{const r=spawnSync(process.execPath,[script,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 const child=['run','--project-root',root,'--stage','child','--',process.execPath,'-e','console.log(JSON.stringify({usage:{input_tokens:null,prompt_tokens:125,output_tokens:0}}))'];
 const outer=run(['run','--project-root',root,'--stage','parent','--',process.execPath,script,...child]);
 const report=JSON.parse(fs.readFileSync(outer.metrics,'utf8'));
 assert.equal(report.tokens.input,125);assert.equal(report.tokens.output,0);assert.equal(report.accounting.workEvents,1);assert.equal(report.events,2);
 const log=fs.readFileSync(report.eventLog,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(log[0].parentEventId,log[1].eventId);assert.equal(log[0].operationId,log[1].operationId);
 console.log(JSON.stringify({status:'pass',checks:['null-and-zero','usage-alias','mixed-field-evidence','event-dedup','parallel-wall-time','nested-wrapper-accounting']}));
} finally {fs.rmSync(root,{recursive:true,force:true});}
