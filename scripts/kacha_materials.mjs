#!/usr/bin/env node
import { composeMaterialProject, inspectMaterial, materialProjectStatus, renderMaterialProject } from "./material_project.mjs";
import { inspectRuntime } from "./project_orchestrator.mjs";
import { option, repeated } from "./agent_workspace_utils.mjs";
const args = process.argv.slice(2);
try {
  const options = {
    inspect: ["--project-root", "--asset", "--timestamp"],
    compose: ["--project-root", "--storyboard"],
    status: ["--project-root"],
    render: ["--project-root", "--confirm-execute", "--plan-digest"],
  }[args[0]];
  if (!options) throw new Error("需要 materials inspect|compose|render|status 子命令");
  const seen = new Set();
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (!options.includes(flag)) throw new Error(`不支持的参数：${flag}`);
    if (seen.has(flag) && flag !== "--timestamp") throw new Error(`重复参数：${flag}`);
    seen.add(flag);
    if (flag !== "--confirm-execute" && (!args[++index] || args[index].startsWith("--"))) throw new Error(`参数缺少值：${flag}`);
  }
  if (args[0] === "inspect" && !option(args, "--asset")) throw new Error("需要 --asset ID");
  if (args[0] === "compose" && !option(args, "--storyboard")) throw new Error("需要 --storyboard JSON");
  const root = option(args, "--project-root");
  if (!root) throw new Error("需要 --project-root DIR");
  let result;
  if (args[0] === "inspect") result = inspectMaterial(root, option(args, "--asset"), { timestamps: repeated(args, "--timestamp").map(Number) });
  else if (args[0] === "compose") result = composeMaterialProject(root, option(args, "--storyboard"));
  else if (args[0] === "status") result = materialProjectStatus(root);
  else if (args[0] === "render") result = renderMaterialProject(root, { runtime: inspectRuntime(), confirmExecute: args.includes("--confirm-execute"), expectedPlanDigest: option(args, "--plan-digest") });
  else throw new Error("用法：kacha.mjs materials inspect|compose|render|status --project-root DIR [--asset ID --timestamp SEC | --storyboard JSON]");
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(JSON.stringify({ status: "blocked", error: error.message }, null, 2)); process.exitCode = 1; }
