#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  daysBetween,
  hasValue,
  readJson,
  resolveFrom,
  run,
  sha256File,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.error(
    "用法：\n"
      + "  kacha.mjs doctor [--profile core|claude-vision|full]\n"
      + "  kacha.mjs config show|validate|get|init [options]\n"
      + "  kacha.mjs design validate|list|show|resolve|preview|render|qc|gallery|library-qc [options]\n"
      + "  kacha.mjs styleframe render --scene ID --output FILE [options]\n"
      + "  kacha.mjs beauty validate|show|authorize|render|qc [options]\n"
      + "  kacha.mjs effects list|show|validate|preview [options]\n"
      + "  kacha.mjs sfx validate|import|align [options]\n"
      + "  kacha.mjs bgm plan|validate [options]\n"
      + "  kacha.mjs facefusion probe|profiles|template|validate|run [options]\n"
      + "  kacha.mjs templates validate|list|show|resolve [options]\n"
      + "  kacha.mjs contracts validate|list|show|resolve [options]\n"
      + "  kacha.mjs visual-capabilities template|validate [options]\n"
      + "  kacha.mjs production-quality template|validate|anti-web-audit [options]\n"
      + "  kacha.mjs cover template|validate|prompt [options]\n"
      + "  kacha.mjs fonts scan|validate|resolve|preview [options]\n"
      + "  kacha.mjs captions plan|validate|render [options]\n"
      + "  kacha.mjs breathing plan|validate|render [options]\n"
      + "  kacha.mjs studio catalog|validate|probe|save-style|compile|serve [options]\n"
      + "  kacha.mjs start --brief BRIEF|--source VIDEO|--script FILE [options]\n"
      + "  kacha.mjs run|resume|status PROJECT [options]\n"
      + "  kacha.mjs handoff PROJECT --source VIDEO --confirm-content-approved [options]\n"
      + "  kacha.mjs content status|record-fact|record-asset|approve PROJECT [options]\n"
      + "  kacha.mjs workflow validate\n"
      + "  kacha.mjs netstyle list|validate|preview|showcase [options]\n"
      + "  kacha.mjs netstyle plan|validate-plan|render-plan [options]\n"
      + "  kacha.mjs connections VIDEO --output connection-candidates.json\n"
      + "  kacha.mjs prepare --task TASK [--modules a,b] [--agent codex|claude]\n"
      + "  kacha.mjs next <project-manifest.json>\n"
      + "  kacha.mjs compile-change <change-request.json> [--output-dir DIR]\n"
      + "  kacha.mjs visual-evidence <video> --output-dir DIR [--mode fast|review|release]\n"
      + "  kacha.mjs vision-enrich <visual-evidence.json> --context CONTEXT --allow-external-upload\n"
      + "  kacha.mjs metrics run|summarize [options]\n"
      + "  kacha.mjs resources status|run [options]\n"
      + "  kacha.mjs delta diff|apply [options]\n"
      + "  kacha.mjs editor inspect|project|query|history|command|preview-capabilities [options]\n"
      + "  kacha.mjs mcp serve --root /absolute/project\n"
      + "  kacha.mjs mcp-config show|validate|install --client codex|claude --root /absolute/project\n"
      + "  kacha.mjs media index|search [options]\n"
      + "  kacha.mjs capabilities validate|list|probe|rank [options]\n"
      + "  kacha.mjs cost init|estimate|reserve|approve|consume|reconcile|refund|status|validate [options]\n"
      + "  kacha.mjs reference analyze|derive|validate [options]\n"
      + "  kacha.mjs rhythm analyze|validate --input MEDIA [options]\n"
      + "  kacha.mjs flight snapshot|replay|validate [options]\n"
      + "  kacha.mjs corpus build|search|validate [options]\n"
      + "  kacha.mjs composition template|route|validate [options]\n"
      + "  kacha.mjs workflows validate|list|show|resolve [options]\n"
      + "  kacha.mjs asset-inbox build|refresh|attach|validate [options]\n"
      + "  kacha.mjs jobs submit|status|list|cancel|resume [options]\n"
      + "  kacha.mjs refs index|resolve|parse [options]\n"
      + "  kacha.mjs intelligence validate|director|assets|perception|observe|validate-plan [options]\n"
      + "  kacha.mjs eval template|cohort-template|validate|score|compare [options]\n"
      + "  kacha.mjs review build|show|validate|record|learn|activate|rollback [options]\n"
      + "  kacha.mjs release-review open|init|record|approve <project-manifest.json> [options]\n"
      + "  kacha.mjs nle export|import --format otio|fcpxml|cmx3600 [options]\n"
      + "  kacha.mjs nle-app detect|session|record|validate [options]\n"
      + "  kacha.mjs install status|sync [options]\n"
      + "  kacha.mjs cache key|run|inspect [options]\n"
      + "  kacha.mjs efficiency validate-policy|plan|validate|schedule|execute|cache-audit|compare [options]\n"
      + "  kacha.mjs transcribe INPUT --output TRANSCRIPT.json [options]\n"
      + "  kacha.mjs transcript index|slice TRANSCRIPT.json [options]\n"
      + "  kacha.mjs masks INPUT --output-dir DIR [options]\n"
      + "  kacha.mjs generated-cache run --plan PLAN --shot ID --output VIDEO -- COMMAND\n"
      + "  kacha.mjs rules validate|query|compile|apply [options]\n"
      + "  kacha.mjs state snapshot|record [options]\n"
      + "  kacha.mjs golden real --video VIDEO --output-dir DIR [options]\n"
      + "  kacha.mjs optimization-audit run --golden-report FILE --test-report FILE "
        + "--asr-report FILE --install-report FILE\n"
      + "  kacha.mjs timeline validate|compile|render|migrate-timebase --plan TIMELINE.json [options]\n"
      + "  kacha.mjs render <project-manifest.json> [--mode preview|final]\n"
      + "  kacha.mjs gate-plan <project-manifest.json>\n"
      + "  kacha.mjs gate-render <project-manifest.json>\n"
      + "  kacha.mjs qc <project-manifest.json>\n"
      + "  kacha.mjs gate-candidate <incremental-project.json>\n"
      + "  kacha.mjs gate-release <project-manifest.json>",
  );
}

function entryPath(entry) {
  return typeof entry === "string" ? entry : entry?.path;
}

function requireProjectPath(projectFile, entry, label) {
  const candidate = entryPath(entry);
  if (!hasValue(candidate)) throw new Error(`${label} 缺少 path`);
  const resolved = resolveFrom(projectFile, candidate);
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error(`${label} 不存在：${resolved ?? candidate}`);
  }
  return resolved;
}

function projectPath(projectFile, entry, label) {
  const candidate = entryPath(entry);
  if (!hasValue(candidate)) throw new Error(`${label} 缺少 path`);
  return resolveFrom(projectFile, candidate);
}

function invoke(script, args, options = {}) {
  const result = run(
    process.execPath,
    [path.join(scriptDirectory, script), ...args],
    options,
  );
  if (result.stdout.trim()) process.stdout.write(`${result.stdout.trim()}\n`);
  if (result.status !== 0) {
    if (result.stderr.trim()) process.stderr.write(`${result.stderr.trim()}\n`);
    process.exit(result.status ?? 1);
  }
}

const [, , command, projectInput, ...remainingArguments] = process.argv;
if (
  command === "netstyle"
  && ["plan", "validate-plan", "render-plan"].includes(projectInput)
) {
  const timelineAction = {
    plan: "plan",
    "validate-plan": "validate",
    "render-plan": "render",
  }[projectInput];
  invoke("netstyle_timeline.mjs", [timelineAction, ...remainingArguments]);
  process.exit(0);
}
const delegatedCommands = {
  doctor: "kacha_doctor.mjs",
  config: "kacha_config.mjs",
  design: "kacha_design.mjs",
  styleframe: "render_styleframe_cached.mjs",
  beauty: "kacha_beauty.mjs",
  effects: "kacha_effects.mjs",
  sfx: "kacha_sfx.mjs",
  bgm: "adaptive_bgm.mjs",
  facefusion: "kacha_facefusion.mjs",
  templates: "kacha_templates.mjs",
  contracts: "kacha_motion_contracts.mjs",
  "visual-capabilities": "visual_capability_plan.mjs",
  "production-quality": "production_quality_contract.mjs",
  cover: "kacha_cover.mjs",
  fonts: "kacha_fonts.mjs",
  captions: "caption_layout.mjs",
  breathing: "visual_breathing.mjs",
  studio: "kacha_studio.mjs",
  start: "kacha_orchestrator.mjs",
  run: "kacha_orchestrator.mjs",
  resume: "kacha_orchestrator.mjs",
  status: "kacha_orchestrator.mjs",
  handoff: "kacha_orchestrator.mjs",
  workflow: "kacha_orchestrator.mjs",
  content: "content_project.mjs",
  netstyle: "kacha_netstyle.mjs",
  connections: "scan_connections.mjs",
  prepare: "prepare_agent_packet.mjs",
  next: "next_action.mjs",
  "compile-change": "compile_change_request.mjs",
  "visual-evidence": "build_visual_evidence.mjs",
  "vision-enrich": "enrich_visual_evidence_minimax.mjs",
  metrics: "run_telemetry.mjs",
  resources: "resource_scheduler.mjs",
  delta: "kacha_delta.mjs",
  editor: "kacha_editor.mjs",
  mcp: "kacha_mcp_server.mjs",
  "mcp-config": "kacha_mcp_config.mjs",
  media: "kacha_media.mjs",
  capabilities: "capability_broker.mjs",
  cost: "cost_ledger.mjs",
  reference: "reference_intelligence.mjs",
  rhythm: "rhythm_analysis.mjs",
  flight: "production_flight_recorder.mjs",
  corpus: "media_corpus.mjs",
  composition: "composition_router.mjs",
  workflows: "workflow_packs.mjs",
  "asset-inbox": "asset_inbox.mjs",
  jobs: "kacha_jobs.mjs",
  refs: "kacha_refs.mjs",
  intelligence: "kacha_intelligence.mjs",
  eval: "kacha_eval.mjs",
  review: "kacha_review.mjs",
  "release-review": "release_review.mjs",
  nle: "kacha_nle.mjs",
  "nle-app": "nle_application_validation.mjs",
  install: "kacha_install.mjs",
  cache: "artifact_cache.mjs",
  efficiency: "quality_efficiency.mjs",
  transcribe: "transcribe_local.mjs",
  transcript: "transcript_window.mjs",
  masks: "generate_masks_cached.mjs",
  "generated-cache": "run_generated_media_cached.mjs",
  rules: "decision_rules.mjs",
  state: "project_state.mjs",
  golden: "golden_regression.mjs",
  "optimization-audit": "optimization_audit.mjs",
  timeline: "timeline_ir.mjs",
  render: "render_project.mjs",
};
if (Object.hasOwn(delegatedCommands, command)) {
  if ((command === "studio" || command === "mcp") && projectInput === "serve") {
    invoke(
      delegatedCommands[command],
      [projectInput, ...remainingArguments],
      { stdio: "inherit" },
    );
    process.exit(0);
  }
  const delegatedArguments = ["start", "run", "resume", "status", "handoff", "workflow"]
    .includes(command)
    ? [command === "workflow" ? projectInput : command, ...(command === "workflow"
      ? remainingArguments
      : [projectInput, ...remainingArguments])]
    : [projectInput, ...remainingArguments];
  invoke(
    delegatedCommands[command],
    delegatedArguments.filter((item) => item !== undefined),
  );
  process.exit(0);
}
if (
  !["gate-plan", "gate-render", "qc", "gate-candidate", "gate-release"].includes(command)
  || !projectInput
) {
  usage();
  process.exit(2);
}

const projectFile = path.resolve(projectInput);
let project;
try {
  project = readJson(projectFile);
} catch (error) {
  console.error(`无法读取项目 manifest：${error.message}`);
  process.exit(2);
}
if (!["2.0", "3.0"].includes(project.schemaVersion)) {
  console.error("project schemaVersion 必须为 2.0 或 3.0");
  process.exit(1);
}
if (project.schemaVersion === "2.0") {
  for (const field of ["projectId", "plans", "outputs", "expectedMedia"]) {
    if (!hasValue(project[field])) {
      console.error(`project 缺少 ${field}`);
      process.exit(1);
    }
  }
  if (!Array.isArray(project.requiredCoverAspectRatios)) {
    console.error("project.requiredCoverAspectRatios 必须是数组，可以为空");
    process.exit(1);
  }
}

function gatePlanV2() {
  const proposal = requireProjectPath(
    projectFile,
    project.plans.proposal,
    "plans.proposal",
  );
  const editPlan = requireProjectPath(
    projectFile,
    project.plans.editPlan,
    "plans.editPlan",
  );
  invoke("validate_edit_proposal.mjs", [proposal]);
  invoke("validate_edit_plan.mjs", [editPlan]);
  let adaptiveBgm = null;
  if (project.expectedMedia?.audioMix?.adaptiveBgmRequired === true) {
    adaptiveBgm = requireProjectPath(
      projectFile,
      project.plans.adaptiveBgm,
      "plans.adaptiveBgm",
    );
    invoke("adaptive_bgm.mjs", ["validate", "--plan", adaptiveBgm]);
  }
  if (project.plans.qualityEfficiency) {
    const qualityEfficiency = requireProjectPath(
      projectFile,
      project.plans.qualityEfficiency,
      "plans.qualityEfficiency",
    );
    invoke("quality_efficiency.mjs", ["validate", qualityEfficiency]);
  }
  const proposalPlan = readJson(proposal);
  if (
    proposalPlan.authorization?.canExecute === true
    && proposalPlan.visualCapabilityPolicy?.coveragePlanRequired === true
  ) {
    const visualCapabilityPlan = requireProjectPath(
      projectFile,
      project.plans.visualCapabilityPlan,
      "plans.visualCapabilityPlan",
    );
    invoke("visual_capability_plan.mjs", [
      "validate",
      "--plan",
      visualCapabilityPlan,
    ]);
  }

  for (const entry of project.plans.netstyleTimelines ?? []) {
    const plan = requireProjectPath(
      projectFile,
      entry,
      "plans.netstyleTimelines",
    );
    invoke("netstyle_timeline.mjs", ["validate", "--plan", plan]);
  }

  for (const entry of project.plans.captionTimelines ?? []) {
    const plan = requireProjectPath(
      projectFile,
      entry,
      "plans.captionTimelines",
    );
    invoke("caption_layout.mjs", ["validate", "--plan", plan]);
  }

  for (const entry of project.plans.visualBreathingTimelines ?? []) {
    const plan = requireProjectPath(
      projectFile,
      entry,
      "plans.visualBreathingTimelines",
    );
    invoke("visual_breathing.mjs", ["validate", "--plan", plan]);
  }

  if (project.plans.timeline ?? project.plans.timelineIr) {
    const timeline = requireProjectPath(
      projectFile,
      project.plans.timeline ?? project.plans.timelineIr,
      "plans.timeline",
    );
    invoke("timeline_ir.mjs", ["validate", "--plan", timeline]);
    const timelinePlan = readJson(timeline);
    const proposalPlan = readJson(proposal);
    const editPlanIdentity = sha256File(editPlan);
    const proposalIdentity = sha256File(proposal);
    for (const [name, file, expected] of [
      ["proposal", proposal, proposalIdentity],
      ["editPlan", editPlan, editPlanIdentity],
    ]) {
      const contract = timelinePlan.contracts?.[name];
      const contractFile = contract
        ? resolveFrom(timeline, entryPath(contract))
        : null;
      if (
        !contractFile
        || path.resolve(contractFile) !== path.resolve(file)
        || contract.sha256 !== expected
      ) {
        console.error(
          `Timeline IR contracts.${name} 必须绑定当前项目文件及其真实 SHA-256`,
        );
        process.exit(1);
      }
    }
    const timelineAssets = [
      ...(timelinePlan.visual?.overlays ?? []),
      ...(timelinePlan.visual?.subtitles ? [timelinePlan.visual.subtitles] : []),
      ...(timelinePlan.audio?.dialogue ? [timelinePlan.audio.dialogue] : []),
      ...(timelinePlan.audio?.bgm?.segments
        ? timelinePlan.audio.bgm.segments
        : timelinePlan.audio?.bgm ? [timelinePlan.audio.bgm] : []),
      ...(timelinePlan.audio?.sfx ?? []),
    ];
    for (const [index, asset] of timelineAssets.entries()) {
      const assetFile = resolveFrom(timeline, entryPath(asset));
      if (
        !assetFile
        || !asset.sha256
        || asset.sha256 !== sha256File(assetFile)
        || !hasValue(asset.provenance?.kind)
        || !hasValue(asset.provenance?.evidence)
      ) {
        console.error(
          `Timeline IR 外部素材[${index}] 必须记录真实 sha256 与 provenance.kind/evidence`,
        );
        process.exit(1);
      }
    }
    const timelineSource = resolveFrom(timeline, entryPath(timelinePlan.source));
    const approvedSources = new Set(
      (proposalPlan.sourceInventory ?? [])
        .map((entry) => resolveFrom(proposal, entryPath(entry)))
        .filter(Boolean)
        .map((entry) => path.resolve(entry)),
    );
    if (!timelineSource || !approvedSources.has(path.resolve(timelineSource))) {
      console.error("Timeline IR 的源视频不在 editProposal 已授权 sourceInventory 中");
      process.exit(1);
    }
    if (timelinePlan.mode !== "final") {
      console.error("登记到完整项目的 Timeline IR 必须声明 mode=final");
      process.exit(1);
    }
    const timelineOutput = resolveFrom(timeline, entryPath(timelinePlan.output));
    const projectOutput = projectPath(
      projectFile,
      project.outputs.finalVideo,
      "outputs.finalVideo",
    );
    if (path.resolve(timelineOutput) !== path.resolve(projectOutput)) {
      console.error("Timeline IR output.path 必须与 project.outputs.finalVideo.path 一致");
      process.exit(1);
    }
    for (const [field, expected] of [
      ["width", project.expectedMedia.width],
      ["height", project.expectedMedia.height],
      ["fps", project.expectedMedia.fps],
    ]) {
      if (
        Number.isFinite(Number(expected))
        && Number(timelinePlan.output?.[field]) !== Number(expected)
      ) {
        console.error(`Timeline IR output.${field} 与 project.expectedMedia.${field} 不一致`);
        process.exit(1);
      }
    }
    for (const [timelineField, projectField] of [
      ["dialogueStem", "dialogue"],
      ["bgmStem", "bgm"],
      ["sfxStem", "sfx"],
      ["mixStem", "mix"],
    ]) {
      const expectedEntry = project.outputs?.audioStems?.[projectField];
      if (!expectedEntry && !timelinePlan.output?.[timelineField]) continue;
      const timelineStem = resolveFrom(timeline, timelinePlan.output?.[timelineField]);
      const projectStem = projectPath(
        projectFile,
        expectedEntry,
        `outputs.audioStems.${projectField}`,
      );
      if (
        !timelineStem
        || !projectStem
        || path.resolve(timelineStem) !== path.resolve(projectStem)
      ) {
        console.error(
          `Timeline IR output.${timelineField} 必须与 outputs.audioStems.${projectField} 一致`,
        );
        process.exit(1);
      }
    }
    if (
      project.expectedMedia?.audioMix?.bgmRequired === true
      && (!timelinePlan.audio?.bgm || !timelinePlan.output?.mixStem)
    ) {
      console.error("项目要求 BGM 时，Timeline IR 必须声明 audio.bgm 与 output.mixStem");
      process.exit(1);
    }
    if (adaptiveBgm) {
      const binding = timelinePlan.audio?.bgm?.adaptivePlan;
      const boundFile = binding ? resolveFrom(timeline, entryPath(binding)) : null;
      if (
        !boundFile
        || path.resolve(boundFile) !== path.resolve(adaptiveBgm)
        || binding.sha256 !== sha256File(adaptiveBgm)
      ) {
        console.error(
          "Timeline IR audio.bgm.adaptivePlan 必须绑定当前自适应配乐计划及真实 SHA-256",
        );
        process.exit(1);
      }
    }
  }

  if (project.plans.localChange) {
    const localChange = requireProjectPath(
      projectFile,
      project.plans.localChange,
      "plans.localChange",
    );
    const argumentsList = [localChange];
    if (
      typeof project.plans.localChange === "object"
      && project.plans.localChange.mode === "template"
    ) {
      argumentsList.push("--template");
    }
    invoke("validate_local_change_plan.mjs", argumentsList);
  }

  for (const entry of project.plans.generatedShotPlans ?? []) {
    const plan = requireProjectPath(projectFile, entry, "generatedShotPlans");
    const argumentsList = [plan];
    if (entry.mode === "template") argumentsList.push("--template");
    invoke("validate_generated_shot_plan.mjs", argumentsList);
  }
}

function validateCapabilities() {
  if ((project.requiredCapabilities ?? []).length === 0) {
    console.log(
      JSON.stringify(
        {
          status: "pass",
          capabilityManifest: null,
          requiredCapabilities: [],
          reused: true,
        },
        null,
        2,
      ),
    );
    return;
  }
  const capabilityFile = requireProjectPath(
    projectFile,
    project.capabilityManifest,
    "capabilityManifest",
  );
  const manifest = readJson(capabilityFile);
  const errors = [];
  if (manifest.schemaVersion !== "2.0") errors.push("能力 manifest schemaVersion 必须为 2.0");
  if (manifest.status !== "pass") errors.push("能力探测状态不是 pass");
  const generatedDate = String(manifest.generatedAt ?? "").slice(0, 10);
  const age = daysBetween(generatedDate);
  if (!Number.isFinite(age) || age < 0 || age > 2) {
    errors.push("能力探测结果必须在两天内生成");
  }
  const checks = new Map((manifest.checks ?? []).map((item) => [item.id, item]));
  for (const capability of project.requiredCapabilities ?? []) {
    if (checks.get(capability)?.available !== true) {
      errors.push(`项目所需能力不可用：${capability}`);
    }
  }
  if (errors.length > 0) {
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        status: "pass",
        capabilityManifest: capabilityFile,
        requiredCapabilities: project.requiredCapabilities ?? [],
      },
      null,
      2,
    ),
  );
}

function gatePlanV3() {
  invoke("validate_incremental_project.mjs", [projectFile]);
  const context = requireProjectPath(projectFile, project.context, "context");
  const delta = requireProjectPath(projectFile, project.delta, "delta");
  const artifactIndex = requireProjectPath(
    projectFile,
    project.artifactIndex,
    "artifactIndex",
  );
  const incrementalPlan = projectPath(
    projectFile,
    project.outputs.incrementalPlan,
    "outputs.incrementalPlan",
  );
  invoke("validate_project_context.mjs", [context]);
  invoke("validate_artifact_index.mjs", [artifactIndex]);
  invoke("validate_version_delta.mjs", [delta]);
  invoke("plan_incremental_build.mjs", [
    context,
    delta,
    artifactIndex,
    "--output",
    incrementalPlan,
  ]);
}

function validateProductionQuality(stage) {
  const required = project.productionQualityV1?.required === true;
  const entry = project.plans?.productionQuality;
  if (!entry && required) {
    console.error(`生产质量${stage}门禁缺少 plans.productionQuality`);
    process.exit(1);
  }
  if (!entry) return;
  const contract = requireProjectPath(
    projectFile,
    entry,
    "plans.productionQuality",
  );
  invoke("production_quality_contract.mjs", [
    "validate",
    "--contract",
    contract,
    "--stage",
    stage,
  ]);
}

function identityBindsFile(identity, file) {
  return Boolean(
    identity?.path
    && identity?.sha256
    && path.resolve(identity.path) === path.resolve(file)
    && identity.sha256 === sha256File(file)
  );
}

function validateV6Coherence(stage) {
  const plans = project.plans ?? {};
  const existing = (field) => {
    if (!plans[field]) return null;
    return requireProjectPath(projectFile, plans[field], `plans.${field}`);
  };
  const directorFile = existing("directorPlan");
  const assetFile = existing("assetGapPlan");
  const perceptionFile = existing("temporalPerceptionAudit");
  const sessionFile = existing("semanticReviewSession");
  const timelineEntry = plans.timeline ?? plans.timelineIr;
  const timelineFile = timelineEntry
    ? requireProjectPath(projectFile, timelineEntry, "plans.timeline")
    : null;
  const errors = [];
  const director = directorFile ? readJson(directorFile) : null;
  const asset = assetFile ? readJson(assetFile) : null;
  const perception = perceptionFile ? readJson(perceptionFile) : null;
  let bundle = null;
  if (sessionFile) {
    const session = readJson(sessionFile);
    if (session.bundle?.path && fs.existsSync(path.resolve(session.bundle.path))) {
      bundle = readJson(path.resolve(session.bundle.path));
    }
  }
  if (directorFile && asset && !identityBindsFile(asset.directorPlan, directorFile)) {
    errors.push("V6 coherence: assetGapPlan 没有绑定 manifest 当前的 directorPlan");
  }
  if (directorFile && bundle && !identityBindsFile(bundle.directorPlan, directorFile)) {
    errors.push("V6 coherence: semantic review 没有绑定 manifest 当前的 directorPlan");
  }
  if (perception && bundle && (
    perception.timeline?.sha256 !== bundle.timeline?.sha256
    || path.resolve(perception.timeline?.path ?? "") !== path.resolve(bundle.timeline?.path ?? "")
  )) {
    errors.push("V6 coherence: perception audit 与 semantic review 使用了不同 Timeline IR");
  }
  if (timelineFile && perception && !identityBindsFile(perception.timeline, timelineFile)) {
    errors.push("V6 coherence: perception audit 没有绑定 manifest 当前 Timeline IR");
  }
  if (timelineFile && bundle && !identityBindsFile(bundle.timeline, timelineFile)) {
    errors.push("V6 coherence: semantic review 没有绑定 manifest 当前 Timeline IR");
  }
  if (director && bundle && director.project?.id !== bundle.project?.id) {
    errors.push("V6 coherence: director 与 semantic review 的 project id 不一致");
  }
  if (timelineFile && director) {
    const timeline = readJson(timelineFile);
    if (timeline.projectId && director.project?.id && timeline.projectId !== director.project.id) {
      errors.push("V6 coherence: Timeline 与 director 的 project id 不一致");
    }
  }
  if (errors.length > 0) {
    errors.forEach((error) => console.error(error));
    console.error(`V6 ${stage} evidence set is internally inconsistent`);
    process.exit(1);
  }
}

function validateV6Evidence(stage) {
  const required = project.intelligenceV6?.required === true;
  const plans = project.plans ?? {};
  const entries = stage === "plan"
    ? [
        ["directorPlan", "kacha_intelligence.mjs", ["validate-plan", "--plan", null]],
        ["assetGapPlan", "kacha_intelligence.mjs", ["validate-plan", "--plan", null]],
      ]
    : stage === "render"
      ? [["assetGapPlan", "kacha_intelligence.mjs", ["validate-plan", "--plan", null, "--for-execution"]]]
      : [
          ["temporalPerceptionAudit", "kacha_intelligence.mjs", ["validate-plan", "--plan", null]],
          ["semanticReviewSession", "kacha_review.mjs", ["validate", "--session", null, "--for-candidate"]],
        ];
  for (const [field, script, argumentTemplate] of entries) {
    const entry = plans[field];
    if (!entry && required) {
      console.error(`V6 智能剪辑${stage === "release" ? "发布" : "项目"}缺少 plans.${field}`);
      process.exit(1);
    }
    if (!entry) continue;
    const evidence = requireProjectPath(projectFile, entry, `plans.${field}`);
    invoke(script, argumentTemplate.map((item) => item === null ? evidence : item));
  }
  validateV6Coherence(stage);
}

function gatePlan() {
  if (project.schemaVersion === "3.0") gatePlanV3();
  else gatePlanV2();
  validateProductionQuality("plan");
  validateV6Evidence("plan");
}

if (command === "gate-plan") {
  gatePlan();
} else if (command === "gate-render") {
  gatePlan();
  if (project.schemaVersion === "3.0") {
    const contextFile = requireProjectPath(projectFile, project.context, "context");
    const context = readJson(contextFile);
    if (context.authorization?.canExecute !== true) {
      console.error("project context 未授权执行，render gate 拒绝通过");
      process.exit(1);
    }
    validateCapabilities();
  } else {
    const proposalFile = requireProjectPath(
      projectFile,
      project.plans.proposal,
      "plans.proposal",
    );
    const proposal = readJson(proposalFile);
    if (proposal.authorization?.canExecute !== true) {
      console.error("方案未授权执行，render gate 拒绝通过");
      process.exit(1);
    }
    if (
      (project.plans.generatedShotPlans ?? []).length > 0
      && proposal.authorization?.paidGenerationAllowed !== true
    ) {
      console.error("项目包含生成镜头，但 editProposal 未授权付费生成");
      process.exit(1);
    }
    validateCapabilities();
    if (proposal.visualCapabilityPolicy?.coveragePlanRequired === true) {
      const visualEntry = project.plans.visualCapabilityPlan;
      const visualCapabilityPlan = requireProjectPath(
        projectFile,
        visualEntry,
        "plans.visualCapabilityPlan",
      );
      const argumentsList = [
        "validate",
        "--plan",
        visualCapabilityPlan,
      ];
      if (!(typeof visualEntry === "object" && visualEntry.mode === "template")) {
        const timelineEntry = project.plans.timeline ?? project.plans.timelineIr;
        const timeline = requireProjectPath(
          projectFile,
          timelineEntry,
          "plans.timeline",
        );
        argumentsList.push("--for-execution", "--timeline", timeline);
      }
      invoke("visual_capability_plan.mjs", argumentsList);
    }
    for (const entry of project.plans.generatedShotPlans ?? []) {
      const plan = requireProjectPath(projectFile, entry, "generatedShotPlans");
      invoke("validate_generated_shot_plan.mjs", [plan, "--for-execution"]);
    }
  }
  validateProductionQuality("execution");
  validateV6Evidence("render");
} else if (command === "qc") {
  if (project.schemaVersion === "3.0") {
    gatePlanV3();
    invoke("qc_incremental.mjs", [projectFile, ...remainingArguments]);
  } else {
    invoke("qc_media.mjs", [projectFile, ...remainingArguments]);
  }
} else if (command === "gate-candidate") {
  if (project.schemaVersion !== "3.0") {
    console.error("gate-candidate 只适用于 schemaVersion 3.0 增量项目");
    process.exit(1);
  }
  gatePlanV3();
  invoke("validate_incremental_review.mjs", [
    projectFile,
    "--mode",
    "candidate",
  ]);
} else if (command === "gate-release") {
  gatePlan();
  validateProductionQuality("release");
  validateV6Evidence("release");
  if (project.schemaVersion === "3.0") {
    const context = requireProjectPath(projectFile, project.context, "context");
    const artifactIndex = requireProjectPath(
      projectFile,
      project.artifactIndex,
      "artifactIndex",
    );
    invoke("validate_project_context.mjs", [context, "--full-hash"]);
    invoke("validate_artifact_index.mjs", [artifactIndex, "--full-hash"]);
    invoke("validate_incremental_review.mjs", [
      projectFile,
      "--mode",
      "release",
    ]);
  } else {
    const proposalFile = requireProjectPath(
      projectFile,
      project.plans.proposal,
      "plans.proposal",
    );
    const proposal = readJson(proposalFile);
    if (proposal.authorization?.canExecute !== true) {
      console.error("方案未授权执行，release gate 拒绝通过");
      process.exit(1);
    }
    invoke("validate_release_report.mjs", [projectFile]);
  }
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      command,
      project: project.projectId,
      manifest: projectFile,
    },
    null,
    2,
  ),
);
