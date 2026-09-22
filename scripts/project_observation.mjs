import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeJob } from './job_runtime.mjs';
import { resolveContainedPath } from './agent_workspace_utils.mjs';
const MAX_JSON=2*1024*1024;
function smallJson(file) {
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_JSON)throw new Error(`Observation requires a bounded regular JSON file: ${file}`);
 return JSON.parse(fs.readFileSync(file,'utf8'));
}
export function observeProject(input) {
 let root=path.resolve(input);if(fs.statSync(root).isFile())root=path.dirname(root);
 if(path.basename(root)==='contracts'||path.basename(root)==='.kacha')root=path.dirname(root);
 const directory=resolveContainedPath(root,path.join(root,'.kacha'),{allowMissing:false});
 const orchestration=path.join(directory,'orchestration.json'), material=path.join(directory,'material-project.json');
 const file=fs.existsSync(orchestration)?orchestration:material;
 const project=smallJson(file), warnings=[];
 const stateFile=path.join(directory,'project-state.json');
 let state=null;try{if(fs.existsSync(stateFile))state=smallJson(stateFile);}catch(e){warnings.push(e.message);}
 const stages=Object.entries(state?.stages??{}).map(([id,v])=>({id,status:v.status}));
 const jobsRoot=path.join(directory,'jobs'),jobs=[];
 if(fs.existsSync(jobsRoot)){
  const candidates=fs.readdirSync(jobsRoot,{withFileTypes:true}).filter(e=>e.isDirectory()||(e.isFile()&&e.name.endsWith('.json'))).sort((a,b)=>b.name.localeCompare(a.name));
  for(const e of candidates.slice(0,20)){try{const job=smallJson(resolveContainedPath(root,path.join(jobsRoot,e.name,...(e.isDirectory()?['job.json']:[])),{allowMissing:false}));const observed=observeJob(job);jobs.push({id:job.id,status:observed.status,recordedStatus:job.status,updatedAt:job.updatedAt,recovery:observed.recovery});}catch(e){warnings.push(e.message);}}
  if(candidates.length>20)warnings.push('job_list_truncated');
 }
 const inputInfo=project.input??project.source;
 let inputObservation='not_checked';
 if(inputInfo?.path){try{const st=fs.statSync(inputInfo.path);inputObservation=(inputInfo.sizeBytes!=null&&st.size!==inputInfo.sizeBytes)?'changed_metadata':'metadata_present_unverified';}catch{inputObservation='missing';}}
 return {schemaVersion:'1.0',kind:'kacha-project-observation',status:'observation_only',executionEligible:false,
 projectId:project.projectId,projectRoot:root,revision:project.digest??null,task:project.task,lifecycle:project.lifecycle??null,
 observedAt:new Date().toISOString(),lastRecordedAt:project.updatedAt??project.createdAt??null,
 verification:{status:'not_verified',lastRuntimeCheck:project.runtimeLock?.checkedAt??project.runtime?.checkedAt??null,reason:'execution_preflight_required'},
 inputObservation,progress:{complete:stages.filter(s=>s.status==='complete').length,total:stages.length},stages,jobs,warnings,
 nextAction:{id:'execution_preflight',safeToAutoExecute:false,summary:'执行前使用 run/resume 的当前身份与权限预检；观察结果不能放行'},
 evidenceBoundary:'只读进度，无成片质量、当前哈希、运行时可用性或发布结论'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(observeProject(process.argv[2]),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
