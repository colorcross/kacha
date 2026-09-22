import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireFileLock, writeJsonAtomic, resolveRuntimeCommand, sha256File, sha256Value } from './kacha_utils.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const RECEIPT='.kacha-runtime.json';
export function runtimeToolchain() {
 const tools = {};
 for (const name of ['ffmpeg', 'ffprobe']) {
  const requested = resolveRuntimeCommand(name);
  const found = path.isAbsolute(requested) ? requested : (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, requested)).find(file => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!found) throw new Error(`runtime tool unavailable: ${name}`);
  const binary = fs.realpathSync(found);
  const version = spawnSync(binary, ['-version'], { encoding: 'utf8', timeout: 5000 });
  if (version.status !== 0) throw new Error(`runtime tool cannot start: ${name}`);
  tools[name] = { path: binary, sha256: sha256File(binary), version: version.stdout.trim() };
 }
 tools.node = { path: fs.realpathSync(process.execPath), version: process.version, sha256: sha256File(process.execPath) };
 return { platform: process.platform, arch: process.arch, tools };
}
export function runtimeDigest(root) {
 const files=[];
 function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
  const absolute=path.join(dir,item.name),relative=path.relative(root,absolute);
  if(relative===RECEIPT)continue;
  if(item.isSymbolicLink())throw new Error(`runtime contains symlink: ${relative}`);
  if(item.isDirectory())walk(absolute);else if(item.isFile())files.push(relative);else throw new Error(`unsupported runtime entry: ${relative}`);
 }}walk(root);
 const hash=crypto.createHash('sha256');
 for(const file of files.sort()){hash.update(file);hash.update('\0');hash.update(fs.readFileSync(path.join(root,file)));hash.update('\0');}
 return hash.digest('hex');
}
export function inspectBundle(root, expectedDigest=null) {
 const file=path.join(root,RECEIPT);
 if(fs.lstatSync(root).isSymbolicLink()||fs.lstatSync(file).isSymbolicLink())throw new Error('runtime links are forbidden');
 const receipt=JSON.parse(fs.readFileSync(file,'utf8'));
 for(const required of ['SKILL.md','scripts/kacha.mjs','config/defaults.json'])if(!fs.existsSync(path.join(root,required))||!fs.statSync(path.join(root,required)).isFile())throw new Error(`runtime entry missing: ${required}`);
 if(receipt.kind!=='kacha-frozen-runtime'||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(receipt.sourceRef)||receipt.sourceDirty!==false)throw new Error('invalid frozen runtime provenance');
 if(receipt.toolchain && sha256Value(runtimeToolchain())!==sha256Value(receipt.toolchain))throw new Error('frozen runtime toolchain changed; explicit new runtime required');
 const digest=runtimeDigest(root);
 if(digest!==receipt.bundleDigest||(expectedDigest&&digest!==expectedDigest))throw new Error('frozen runtime content changed');
 return {schemaVersion:'1.0',checkedAt:new Date().toISOString(),skillRoot:path.resolve(root),sourceRef:receipt.sourceRef,sourceDirty:false,
 bundleDigest:digest,installStatus:'pass',productionReady:true,mode:'frozen_bundle',targets:[],diagnostics:[],frozenRuntime:receipt};
}
export function exportRuntime(source, output) {
 if(fs.existsSync(output))throw new Error('runtime output already exists');
 const child=spawnSync(process.execPath,[path.join(ROOT,'scripts/sync_skill_installs.mjs'),'--source',source,'--verify-only','--export-dir',output],{encoding:'utf8',maxBuffer:4*1024*1024});
 if(child.status!==0)throw new Error(child.stderr||child.stdout);
 return inspectBundle(output);
}
export function freezeProjectRuntime(runtime, { home = os.homedir() } = {}) {
 if(runtime.mode==='frozen_bundle')return runtime;
 if(!runtime.productionReady)throw new Error('cannot freeze an unverified production runtime');
 const destination=path.join(home,'.cache','kacha','runtimes',`${runtime.bundleDigest}-${sha256Value(runtimeToolchain()).slice(0,16)}`);
 fs.mkdirSync(path.dirname(destination),{recursive:true});
 const release=acquireFileLock(`${destination}.lock`,{purpose:'freeze-production-runtime'});
 try{return fs.existsSync(destination)?inspectBundle(destination,runtime.bundleDigest):exportRuntime(runtime.skillRoot,destination);}finally{release();}
}
export function projectRuntimeRoot(input) {
 let root=path.resolve(input);
 if(fs.existsSync(root)&&fs.statSync(root).isFile())root=path.dirname(root);
 if(['contracts','.kacha'].includes(path.basename(root)))root=path.dirname(root);
 const initial=root;
 while(root!==path.dirname(root)){if(fs.existsSync(path.join(root,'.kacha/runtime-binding.json'))||fs.existsSync(path.join(root,'.kacha/orchestration.json'))||fs.existsSync(path.join(root,'.kacha/material-project.json')))return root;root=path.dirname(root);}
 return initial;
}
function runtimeTrustRoot() { return process.env.KACHA_RUNTIME_TRUST_ROOT ?? path.join(os.homedir(), '.cache', 'kacha', 'runtime-trust'); }
function trustRuntime(bundle, report) {
 const record = { bundle: fs.realpathSync(bundle), bundleDigest: report.bundleDigest, receiptSha256: sha256File(path.join(bundle, RECEIPT)) };
 const trustId = sha256Value(record), directory = runtimeTrustRoot();
 fs.mkdirSync(directory, {recursive:true,mode:0o700});
 writeJsonAtomic(path.join(directory, `${trustId}.json`), record, {mode:0o600});
 return trustId;
}
function assertTrustedRuntime(binding) {
 if (!/^[a-f0-9]{64}$/.test(binding.trustId ?? '')) throw new Error('运行包未在本机显式绑定；使用 runtime bind 恢复，不能执行项目自带任意脚本');
 const record = JSON.parse(fs.readFileSync(path.join(runtimeTrustRoot(), `${binding.trustId}.json`), 'utf8'));
 if (sha256Value(record) !== binding.trustId || record.bundle !== fs.realpathSync(binding.bundle) || record.bundleDigest !== binding.bundleDigest || record.receiptSha256 !== binding.receiptSha256) throw new Error('runtime binding is not locally trusted');
}
export function bindRuntime(projectRoot,bundle,{acceptUpdate=false}={}){
 const root=projectRuntimeRoot(projectRoot),report=inspectBundle(bundle),lockFile=path.join(root,'.kacha/runtime-binding.json');
 const release=acquireFileLock(path.join(root,'.kacha/runtime-binding.lock'),{purpose:'bind-runtime'});
 try{
  const orchestrationFile=path.join(root,'.kacha/orchestration.json');
  const materialFile=path.join(root,'.kacha/material-project.json');
  const projectFile=fs.existsSync(orchestrationFile)?orchestrationFile:materialFile;
  const project=JSON.parse(fs.readFileSync(projectFile,'utf8'));
  const existing=project.runtimeLock??project.runtime??(project.runtimeRef?{sourceRef:project.runtimeRef,bundleDigest:project.runtimeBundleDigest}:null);
  if(existing&&(existing.sourceRef!==report.sourceRef||existing.bundleDigest!==report.bundleDigest)&&!acceptUpdate)throw new Error('runtime differs; --accept-runtime-update required after contract revalidation');
  // Binding does not rewrite approval, project digest, or runtimeLock. Existing
  // run --accept-runtime-update remains the migration gate for changed contracts.
  if(fs.existsSync(lockFile)){
   const prior=JSON.parse(fs.readFileSync(lockFile,'utf8'));
   if(prior.bundleDigest!==report.bundleDigest&&!acceptUpdate)throw new Error('existing runtime binding requires explicit update');
   const history=path.join(root,'.kacha/runtime-history');fs.mkdirSync(history,{recursive:true});
   fs.copyFileSync(lockFile,path.join(history,`${Date.now()}-${crypto.randomUUID()}.json`),fs.constants.COPYFILE_EXCL);
  }
  const binding={schemaVersion:'1.0',kind:'kacha-runtime-binding',trustId:trustRuntime(bundle,report),bundle:path.resolve(bundle),bundleDigest:report.bundleDigest,receiptSha256:sha256File(path.join(bundle,RECEIPT)),sourceRef:report.sourceRef,boundAt:new Date().toISOString(),migrationRequired:Boolean(existing&&(existing.sourceRef!==report.sourceRef||existing.bundleDigest!==report.bundleDigest))};
  writeJsonAtomic(lockFile,binding);return binding;
 }finally{release();}
}
export function callBoundRuntime(input, argv, currentRoot = ROOT) {
 const root = projectRuntimeRoot(input), file = path.join(root, '.kacha/runtime-binding.json');
 if (!fs.existsSync(file)) return null;
 const binding = JSON.parse(fs.readFileSync(file, 'utf8'));
 assertTrustedRuntime(binding);
 if (binding.receiptSha256 && sha256File(path.join(binding.bundle, RECEIPT)) !== binding.receiptSha256) throw new Error("runtime receipt changed");
 inspectBundle(binding.bundle, binding.bundleDigest);
 if (fs.realpathSync(binding.bundle) === fs.realpathSync(currentRoot)) return null;
 const result = spawnSync(process.execPath, [path.join(binding.bundle, 'scripts/kacha.mjs'), ...argv], {encoding:'utf8',maxBuffer:16*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 let report; try { report = JSON.parse(result.stdout); } catch {}
 if (result.status !== 0 && !(result.status === 1 && report?.status === 'blocked')) throw new Error(result.stderr || result.stdout || 'frozen project command failed');
 return report;
}
export function callBoundProject(input, command, argv = [], currentRoot = ROOT) {
 return callBoundRuntime(input, [command, input, ...argv], currentRoot);
}
export function dispatchBoundRuntime(argv,currentRoot=ROOT){
 const command=argv[0];
 const optionInput=['timeline','craft','real-preview'].includes(command)?argv[argv.indexOf(command==='timeline'?'--plan':'--timeline')+1]:command==='materials'?argv[argv.indexOf('--project-root')+1]:null;
 const input=optionInput??argv[1];
 if(!['timeline','craft','real-preview','materials','run','resume','status','render','gate-plan','gate-render','gate-release','gate-candidate','qc'].includes(command)||!input||input.startsWith('--'))return false;
 if(command==='status'&&argv.includes('--quick'))return false;
 const root=projectRuntimeRoot(input),file=path.join(root,'.kacha/runtime-binding.json');
 if(!fs.existsSync(file))return false;
 if(fs.lstatSync(file).isSymbolicLink())throw new Error('runtime binding must not be a link');
 const binding=JSON.parse(fs.readFileSync(file,'utf8'));
 assertTrustedRuntime(binding);
 if(binding.kind!=='kacha-runtime-binding'||!path.isAbsolute(binding.bundle)||!/^[a-f0-9]{64}$/.test(binding.bundleDigest??''))throw new Error('invalid runtime binding');
 if(binding.receiptSha256&&sha256File(path.join(binding.bundle,RECEIPT))!==binding.receiptSha256)throw new Error("runtime receipt changed");
 inspectBundle(binding.bundle,binding.bundleDigest);
 process.env.PYTHONDONTWRITEBYTECODE='1';
 if(fs.realpathSync(binding.bundle)===fs.realpathSync(currentRoot))return false;
 const result=spawnSync(process.execPath,[path.join(binding.bundle,'scripts/kacha.mjs'),...argv],{stdio:'inherit'});
 process.exitCode=result.status??1;return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),opt=(key)=>args[args.indexOf(key)+1];
 try{
  let result;
  if(args[0]==='create'){if(!args.includes('--output'))throw new Error('--output required');result=exportRuntime(path.resolve(args.includes('--source')?opt('--source'):ROOT),path.resolve(opt('--output')));}
  else if(args[0]==='inspect'){result=inspectBundle(path.resolve(args[1]));}
  else if(args[0]==='bind'){if(!args.includes('--bundle'))throw new Error('--bundle required');result=bindRuntime(args[1],path.resolve(opt('--bundle')),{acceptUpdate:args.includes('--accept-runtime-update')});}
  else throw new Error('runtime create --source DIR --output DIR | inspect DIR | bind PROJECT --bundle DIR [--accept-runtime-update]');
  console.log(JSON.stringify(result,null,2));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
