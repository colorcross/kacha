import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"kacha-installed-identity-"));
try {
  const source=path.join(root,"installed-bundle"), home=path.join(root,"home");
  fs.mkdirSync(path.join(source,"scripts"),{recursive:true});
  fs.writeFileSync(path.join(source,"SKILL.md"),"# Test installed bundle\n");
  fs.copyFileSync(path.join(repo,"scripts/scan_secrets.py"),path.join(source,"scripts/scan_secrets.py"));
  const hash=crypto.createHash("sha256");
  for(const name of ["SKILL.md","scripts/scan_secrets.py"]) {hash.update(name);hash.update("\0");hash.update(fs.readFileSync(path.join(source,name)));hash.update("\0");}
  const version=`core_ref=${"a".repeat(40)}\ncore_dirty=false\ncore_content_sha256=${hash.digest("hex")}\noverlay=none\n`;
  fs.writeFileSync(path.join(source,".kacha-version"),version);
  const targets=["codex","claude"].map(agent=>path.join(home,`.${agent}`,"skills/kacha"));
  for(const target of targets)fs.cpSync(source,target,{recursive:true});
  const check=()=>spawnSync(process.execPath,[path.join(repo,"scripts/kacha_install.mjs"),"status","--source",source,"--home",home,"--agent","both"],{encoding:"utf8"});
  let result=check();assert.equal(result.status,0,result.stderr);let report=JSON.parse(result.stdout);
  assert.equal(report.sourceRef,"a".repeat(40));assert.equal(report.sourceDirty,false);assert.equal(report.status,"pass");
  assert.ok(report.targets.every(target=>target.state==="current"));
  assert.equal(fs.readFileSync(path.join(source,".kacha-version"),"utf8"),version);
  fs.appendFileSync(path.join(targets[0],"SKILL.md"),"changed\n");
  result=check();assert.equal(result.status,0,result.stderr);report=JSON.parse(result.stdout);
  assert.equal(report.status,"sync_required");assert.equal(report.targets[0].state,"out_of_sync");assert.equal(report.targets[1].state,"current");
  fs.writeFileSync(path.join(source,".kacha-version"),version.replace("core_dirty=false","core_dirty=unknown"));
  result=check();assert.notEqual(result.status,0);assert.match(result.stderr,/版本记录无效/);
  fs.writeFileSync(path.join(source,".kacha-version"),version);
  fs.appendFileSync(path.join(source,"SKILL.md"),"source changed\n");
  result=check();assert.notEqual(result.status,0);assert.match(result.stderr,/冻结源码摘要不一致/);
  console.log(JSON.stringify({status:"pass",checks:["installed-envelope-preserved-without-git","actual-target-drift-still-detected","invalid-envelope-rejected","installed-source-payload-must-match-frozen-hash"],readOnly:true},null,2));
} finally {fs.rmSync(root,{recursive:true,force:true});}
