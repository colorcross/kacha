#!/usr/bin/env node
import { composeMaterialProject, inspectMaterial, materialProjectStatus, renderMaterialProject } from "./material_project.mjs";
import { inspectRuntime } from "./project_orchestrator.mjs";
import { option, repeated } from "./agent_workspace_utils.mjs";
const args = process.argv.slice(2);
try {
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
