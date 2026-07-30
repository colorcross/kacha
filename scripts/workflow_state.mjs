import fs from "node:fs";
import path from "node:path";
import {
  fileIdentity,
  fileIdentityMatches,
  readJson,
  resolveFrom,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

export const V2_STAGE_IDS = [
  "inventory",
  "transcript_structure",
  "rough_cut",
  "dialogue_preprocess",
  "connection_qc",
  "fine_cut",
  "visual_packaging",
  "subtitles",
  "final_mix",
  "cover",
  "preview_render",
  "final_qc",
  "release_package",
];

function entryPath(entry) {
  return typeof entry === "string" ? entry : entry?.path;
}

export function defaultStateFile(projectFile) {
  return path.join(path.dirname(path.resolve(projectFile)), ".kacha", "project-state.json");
}

const RUNTIME_MANIFEST_KEYS = new Set([
  "sha256",
  "sizeBytes",
  "mtimeMs",
  "digest",
  "status",
  "generatedAt",
  "updatedAt",
  "recordedAt",
  "completedAt",
]);

function stableManifestShape(value) {
  if (Array.isArray(value)) return value.map((item) => stableManifestShape(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !RUNTIME_MANIFEST_KEYS.has(key))
      .map(([key, item]) => [key, stableManifestShape(item)]),
  );
}

function collectPlanFiles(projectFile, value, label, entries) {
  if (typeof value === "string") {
    const file = resolveFrom(projectFile, value);
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      entries.push([label, file]);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => (
      collectPlanFiles(projectFile, item, `${label}[${index}]`, entries)
    ));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (typeof value.path === "string") {
    collectPlanFiles(projectFile, value.path, label, entries);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    collectPlanFiles(projectFile, item, `${label}.${key}`, entries);
  }
}

export function v2Contract(projectFile, project = readJson(projectFile)) {
  const entries = [];
  for (const [key, value] of Object.entries(project.plans ?? {})) {
    collectPlanFiles(projectFile, value, `plans.${key}`, entries);
  }
  collectPlanFiles(
    projectFile,
    project.capabilityManifest,
    "capabilityManifest",
    entries,
  );
  const files = Object.fromEntries(
    entries.map(([name, file]) => [name, fileIdentity(file)]),
  );
  const manifestSpec = {
    projectPath: path.resolve(projectFile),
    schemaVersion: project.schemaVersion,
    projectId: project.projectId,
    plans: stableManifestShape(project.plans ?? {}),
    capabilityManifest: stableManifestShape(project.capabilityManifest ?? null),
    requiredCapabilities: stableManifestShape(project.requiredCapabilities ?? []),
    expectedMedia: stableManifestShape(project.expectedMedia ?? {}),
    requiredCoverAspectRatios: stableManifestShape(
      project.requiredCoverAspectRatios ?? [],
    ),
    outputs: stableManifestShape(project.outputs ?? {}),
  };
  return {
    manifestSpec,
    files,
    digest: sha256Value({
      manifestSpec,
      files: Object.fromEntries(
        Object.entries(files).map(([name, identity]) => [
          name,
          { path: identity.path, sha256: identity.sha256 },
        ]),
      ),
    }),
  };
}

function verifiedStageEvidence(proposalFile, stage) {
  if (!stage?.evidence || typeof stage.evidence !== "object") return null;
  const file = resolveFrom(proposalFile, stage.evidence.path);
  if (
    !file
    || !fs.existsSync(file)
    || !fs.statSync(file).isFile()
    || fileIdentity(file).sha256 !== stage.evidence.sha256
  ) {
    return null;
  }
  return fileIdentity(file);
}

function initialV2Stages(projectFile, project) {
  const proposalFile = resolveFrom(projectFile, entryPath(project.plans?.proposal));
  const proposal = proposalFile ? readJson(proposalFile) : null;
  const flow = new Map(
    (proposal?.executionFlow ?? []).map((stage) => [stage.id, stage]),
  );
  return Object.fromEntries(V2_STAGE_IDS.map((id) => {
    const stage = flow.get(id);
    if (stage?.status === "passed") {
      const evidence = verifiedStageEvidence(proposalFile, stage);
      if (evidence) return [id, { status: "complete", evidence, source: "proposal" }];
    }
    if (stage?.status === "not_applicable") {
      return [id, {
        status: "complete",
        notApplicable: true,
        reason: stage.notApplicableReason,
        source: "proposal",
      }];
    }
    return [id, { status: stage?.status === "blocked" ? "blocked" : "pending" }];
  }));
}

function evidenceStillCurrent(entry) {
  return !entry?.evidence
    || fileIdentityMatches(entry.evidence.path, entry.evidence);
}

export function loadOrInitializeV2State(projectFile, stateFile = defaultStateFile(projectFile)) {
  const resolvedProject = path.resolve(projectFile);
  const project = readJson(resolvedProject);
  if (project.schemaVersion !== "2.0") {
    throw new Error("V2 workflow state only supports schemaVersion 2.0");
  }
  const contract = v2Contract(resolvedProject, project);
  let previous = null;
  if (fs.existsSync(stateFile)) {
    try {
      previous = readJson(stateFile);
    } catch {
      previous = null;
    }
  }
  const reusable = previous?.kind === "kacha_project_state"
    && previous.schemaVersion === "2.0"
    && previous.projectId === project.projectId
    && previous.contract?.digest === contract.digest
    && V2_STAGE_IDS.every((id) => evidenceStillCurrent(previous.stages?.[id]));
  const stable = {
    schemaVersion: "2.0",
    kind: "kacha_project_state",
    projectId: project.projectId,
    workflow: "full",
    contract,
    stages: reusable ? previous.stages : initialV2Stages(resolvedProject, project),
    decisions: reusable ? previous.decisions ?? [] : [],
  };
  stable.digest = sha256Value(stable);
  const report = { ...stable, updatedAt: new Date().toISOString() };
  writeJsonAtomic(stateFile, report);
  return { state: report, stateFile, reused: reusable };
}

export function firstIncompleteV2Stage(state) {
  for (const id of V2_STAGE_IDS) {
    const entry = state.stages?.[id];
    if (entry?.status !== "complete") return { id, entry: entry ?? { status: "pending" } };
  }
  return null;
}

export function recordV2Stage({
  stateFile,
  stage,
  status,
  evidenceFile,
  decision = null,
}) {
  if (!V2_STAGE_IDS.includes(stage)) throw new Error(`未知 V2 阶段：${stage}`);
  if (!["complete", "blocked"].includes(status)) throw new Error("阶段状态无效");
  const state = readJson(stateFile);
  if (state.kind !== "kacha_project_state" || state.schemaVersion !== "2.0") {
    throw new Error("state 文件类型无效");
  }
  const stageIndex = V2_STAGE_IDS.indexOf(stage);
  const incompletePrerequisite = V2_STAGE_IDS.slice(0, stageIndex)
    .find((id) => state.stages?.[id]?.status !== "complete");
  if (incompletePrerequisite) {
    throw new Error(`前置阶段 ${incompletePrerequisite} 尚未完成`);
  }
  const evidence = fileIdentity(evidenceFile);
  state.stages = {
    ...state.stages,
    [stage]: {
      status,
      recordedAt: new Date().toISOString(),
      evidence,
    },
  };
  if (decision) {
    state.decisions = [
      ...(state.decisions ?? []),
      { stage, text: decision, evidenceSha256: evidence.sha256 },
    ];
  }
  delete state.digest;
  delete state.updatedAt;
  state.digest = sha256Value(state);
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(stateFile, state);
  return state;
}
