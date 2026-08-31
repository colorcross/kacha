import fs from "node:fs";
import path from "node:path";
import {
  acquireFileLock,
  fileIdentity,
  readJson,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { applyJsonOperations } from "./json_mutation.mjs";
import {
  buildTimelineProjection,
  compileProjectionCommand,
  resolveTimelinePath,
} from "./timeline_projection.mjs";
import { compileEditorOperation } from "./editor_operations.mjs";

function now() {
  return new Date().toISOString();
}

function journalRoot(timelineFile) {
  const resolved = resolveTimelinePath(timelineFile);
  const key = sha256Value({ timeline: resolved }).slice(0, 16);
  return path.join(path.dirname(resolved), ".kacha", "editor", `${path.basename(resolved)}-${key}`);
}

function statePaths(timelineFile) {
  const root = journalRoot(timelineFile);
  return {
    root,
    session: path.join(root, "session.json"),
    journal: path.join(root, "journal.jsonl"),
    snapshots: path.join(root, "snapshots"),
    recovery: path.join(root, "recovery.json"),
    lock: path.join(root, "operation.lock"),
  };
}

function enforcePrivateFile(file) {
  if (process.platform === "win32" || !fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isFile() && !stat.isSymbolicLink()) fs.chmodSync(file, 0o600);
}

function enforcePrivateState(paths) {
  for (const file of [paths.session, paths.journal, paths.recovery]) enforcePrivateFile(file);
  if (!fs.existsSync(paths.snapshots) || !fs.statSync(paths.snapshots).isDirectory()) return;
  for (const name of fs.readdirSync(paths.snapshots)) enforcePrivateFile(path.join(paths.snapshots, name));
}

function writeSnapshot(paths, value) {
  const digest = sha256Value(value);
  const file = path.join(paths.snapshots, `${digest}.json`);
  if (!fs.existsSync(file)) writeJsonAtomic(file, value, { mode: 0o600 });
  enforcePrivateFile(file);
  return { path: file, sha256: sha256File(file) };
}

function readJournal(paths, { tolerateTruncated = false } = {}) {
  if (!fs.existsSync(paths.journal)) return { records: [], truncated: false };
  const lines = fs.readFileSync(paths.journal, "utf8").split("\n")
    .map((text, index) => ({ text, lineNumber: index + 1 }))
    .filter((entry) => entry.text.trim());
  const records = [];
  let truncated = false;
  for (const [index, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line.text));
    } catch (error) {
      if (tolerateTruncated && index === lines.length - 1) {
        truncated = true;
        break;
      }
      throw new Error(`journal 第 ${line.lineNumber} 行损坏：${error.message}`);
    }
  }
  return { records, truncated };
}

function readJournalPrefix(paths) {
  if (!fs.existsSync(paths.journal)) {
    return { records: [], parseError: null, invalidLine: null, truncated: false };
  }
  const lines = fs.readFileSync(paths.journal, "utf8").split("\n")
    .map((text, index) => ({ text, lineNumber: index + 1 }))
    .filter((entry) => entry.text.trim());
  const records = [];
  for (const [index, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line.text));
    } catch (error) {
      return {
        records,
        parseError: `journal 第 ${line.lineNumber} 行损坏：${error.message}`,
        invalidLine: line.lineNumber,
        truncated: index === lines.length - 1,
      };
    }
  }
  return { records, parseError: null, invalidLine: null, truncated: false };
}

function validRecordPrefix(records) {
  let previousDigest = null;
  for (const [index, record] of records.entries()) {
    if (record.previousRecordDigest !== previousDigest) {
      return { records: records.slice(0, index), error: `journal[${index}] previousRecordDigest 断链` };
    }
    const unsigned = { ...record };
    delete unsigned.recordDigest;
    const expected = sha256Value(unsigned);
    if (record.recordDigest !== expected) {
      return { records: records.slice(0, index), error: `journal[${index}] recordDigest 失效` };
    }
    previousDigest = record.recordDigest;
  }
  return { records, error: null };
}

function validateRecordChain(records) {
  let previousDigest = null;
  for (const [index, record] of records.entries()) {
    if (record.previousRecordDigest !== previousDigest) {
      throw new Error(`journal[${index}] previousRecordDigest 断链`);
    }
    const unsigned = { ...record };
    delete unsigned.recordDigest;
    const expected = sha256Value(unsigned);
    if (record.recordDigest !== expected) throw new Error(`journal[${index}] recordDigest 失效`);
    previousDigest = record.recordDigest;
  }
  return previousDigest;
}

function appendRecord(paths, record) {
  const { records } = readJournal(paths);
  const previousRecordDigest = validateRecordChain(records);
  const next = { ...record, previousRecordDigest };
  next.recordDigest = sha256Value(next);
  fs.mkdirSync(paths.root, { recursive: true });
  const previous = {
    existed: fs.existsSync(paths.journal),
    size: fs.existsSync(paths.journal) ? fs.statSync(paths.journal).size : 0,
  };
  const descriptor = fs.openSync(paths.journal, "a", 0o600);
  try {
    if (process.platform !== "win32") fs.fchmodSync(descriptor, 0o600);
    const payload = Buffer.from(`${JSON.stringify(next)}\n`);
    let offset = 0;
    while (offset < payload.length) {
      offset += fs.writeSync(descriptor, payload, offset, payload.length - offset, null);
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (previous.existed) fs.ftruncateSync(descriptor, previous.size);
    else {
      fs.closeSync(descriptor);
      if (fs.existsSync(paths.journal)) fs.unlinkSync(paths.journal);
      throw error;
    }
    throw error;
  } finally {
    try { fs.closeSync(descriptor); } catch {}
  }
  return { record: next, previous };
}

function restoreJournal(paths, previous) {
  if (!previous.existed) {
    if (fs.existsSync(paths.journal)) fs.unlinkSync(paths.journal);
    return;
  }
  fs.truncateSync(paths.journal, previous.size);
}

function writeJournalRecords(paths, records) {
  fs.mkdirSync(paths.root, { recursive: true });
  const temporary = `${paths.journal}.recovery-${process.pid}-${Date.now()}`;
  fs.writeFileSync(
    temporary,
    records.length > 0 ? `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "",
    { mode: 0o600 },
  );
  fs.renameSync(temporary, paths.journal);
}

function validateSession(session, resolved) {
  if (
    !session
    || session.schemaVersion !== "1.0"
    || session.kind !== "kacha-editor-session"
    || session.timelinePath !== resolved
    || !Array.isArray(session.undoStack)
    || !Array.isArray(session.redoStack)
    || !/^[a-f0-9]{64}$/.test(String(session.currentSha256 ?? ""))
    || !session.undoStack.every((entry) => typeof entry === "string" && entry)
    || !session.redoStack.every((entry) => typeof entry === "string" && entry)
  ) throw new Error("editor session 合同无效");
}

function existingSession(timelineFile) {
  const resolved = resolveTimelinePath(timelineFile);
  const paths = statePaths(resolved);
  if (!fs.existsSync(paths.session)) return null;
  enforcePrivateState(paths);
  const session = readJson(paths.session);
  validateSession(session, resolved);
  return { resolved, paths, session };
}

function reconstructStacks(records) {
  const undoStack = [];
  const redoStack = [];
  for (const [index, record] of records.entries()) {
    if (record.action === "apply") {
      if (!record.commandId || undoStack.includes(record.commandId) || redoStack.includes(record.commandId)) {
        throw new Error(`journal[${index}] apply commandId 无效或重复`);
      }
      undoStack.push(record.commandId);
      redoStack.length = 0;
    } else if (record.action === "undo") {
      if (undoStack.at(-1) !== record.commandId) throw new Error(`journal[${index}] undo 栈不一致`);
      redoStack.push(undoStack.pop());
    } else if (record.action === "redo") {
      if (redoStack.at(-1) !== record.commandId) throw new Error(`journal[${index}] redo 栈不一致`);
      undoStack.push(redoStack.pop());
    } else if (record.action !== "recover") {
      throw new Error(`journal[${index}] action 不支持：${record.action}`);
    }
  }
  return { undoStack, redoStack };
}

function safeSnapshot(paths, reference) {
  if (!reference?.path || !/^[a-f0-9]{64}$/.test(String(reference.sha256 ?? ""))) {
    throw new Error("恢复快照引用无效");
  }
  const requested = path.resolve(reference.path);
  if (!fs.existsSync(requested)) throw new Error("恢复快照不存在或摘要失效");
  const snapshotsRoot = fs.realpathSync(paths.snapshots);
  const snapshot = fs.realpathSync(requested);
  const relative = path.relative(snapshotsRoot, snapshot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("恢复快照越出 snapshots 目录");
  if (!fs.existsSync(snapshot) || !fs.statSync(snapshot).isFile() || sha256File(snapshot) !== reference.sha256) {
    throw new Error("恢复快照不存在或摘要失效");
  }
  return { reference: { path: snapshot, sha256: reference.sha256 }, value: readJson(snapshot) };
}

function archiveEditorState(paths, timelineFile, label) {
  const stamp = now().replace(/[:.]/g, "-");
  const archive = path.join(paths.root, "archive", `${stamp}-${label}`);
  fs.mkdirSync(archive, { recursive: true });
  const files = [
    [timelineFile, `timeline-${path.basename(timelineFile)}`],
    [paths.session, "session.json"],
    [paths.journal, "journal.jsonl"],
    [paths.recovery, "recovery.json"],
  ];
  for (const [source, name] of files) {
    if (fs.existsSync(source) && fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(archive, name));
  }
  return archive;
}

function restoreArchivedState(archive, paths, timelineFile) {
  const files = [
    [path.join(archive, `timeline-${path.basename(timelineFile)}`), timelineFile],
    [path.join(archive, "session.json"), paths.session],
    [path.join(archive, "journal.jsonl"), paths.journal],
    [path.join(archive, "recovery.json"), paths.recovery],
  ];
  for (const [source, target] of files) {
    if (fs.existsSync(source)) fs.copyFileSync(source, target);
    else if (target !== timelineFile && fs.existsSync(target)) fs.unlinkSync(target);
  }
}

function expectedSha(value, current) {
  if (!/^[a-f0-9]{64}$/.test(String(value ?? ""))) {
    throw new Error("恢复或重开必须提供当前 Timeline 的 expectedCurrentSha256");
  }
  if (value !== current) throw new Error(`Timeline 当前 SHA 已变化：expected ${value}, current ${current}`);
}

function loadOrCreateSession(timelineFile, { includeSourceHash = false } = {}) {
  const resolved = resolveTimelinePath(timelineFile);
  const paths = statePaths(resolved);
  const projection = buildTimelineProjection(resolved, { includeSourceHash });
  fs.mkdirSync(paths.snapshots, { recursive: true });
  enforcePrivateState(paths);
  let session;
  if (fs.existsSync(paths.session)) {
    session = readJson(paths.session);
    validateSession(session, resolved);
  } else {
    session = {
      schemaVersion: "1.0",
      kind: "kacha-editor-session",
      sessionId: `editor-${sha256Value({ timeline: resolved, createdAt: now() }).slice(0, 20)}`,
      timelinePath: resolved,
      openedIdentity: fileIdentity(resolved),
      currentSha256: sha256File(resolved),
      timebase: projection.timebase,
      createdAt: now(),
      updatedAt: now(),
      undoStack: [],
      redoStack: [],
    };
    session.initialSnapshot = writeSnapshot(paths, readJson(resolved));
    writeJsonAtomic(paths.session, session, { mode: 0o600 });
  }
  return { session, paths, projection };
}

function assertCurrent(session, timelineFile, expectedSha = null) {
  const current = sha256File(timelineFile);
  if (current !== session.currentSha256) {
    throw new Error(`Timeline 已被其他进程修改：session ${session.currentSha256}, current ${current}`);
  }
  if (expectedSha !== null && expectedSha !== session.currentSha256) {
    throw new Error(`Command base SHA 已过期：expected ${session.currentSha256}, received ${expectedSha}`);
  }
  return current;
}

function requiredMutationSha(value, label = "baseSha256") {
  if (!/^[a-f0-9]{64}$/.test(String(value ?? ""))) {
    throw new Error(`${label} 必须是当前 Timeline 的 64 位小写 SHA-256`);
  }
  return value;
}

function commandRecord(records, commandId) {
  const record = records.find((entry) => entry.action === "apply" && entry.commandId === commandId);
  if (!record) throw new Error(`历史 command 不存在：${commandId}`);
  return record;
}

function auditText(value, fallback, label) {
  const candidate = value ?? fallback;
  if (typeof candidate !== "string") throw new Error(`${label} 必须为 1–500 个无控制符字符`);
  const normalized = candidate.trim();
  if (!normalized || normalized.length > 500 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} 必须为 1–500 个无控制符字符`);
  }
  return normalized;
}

function applyOperationsToTimeline({ timelineFile, operations, expectedSha, paths }) {
  const before = readJson(timelineFile);
  const beforeSha256 = sha256File(timelineFile);
  if (beforeSha256 !== expectedSha) throw new Error("Command base SHA 已过期");
  const { value: after, inverseOperations } = applyJsonOperations(before, operations, {
    captureInverse: true,
  });
  const beforeSnapshot = writeSnapshot(paths, before);
  writeJsonAtomic(timelineFile, after);
  try {
    buildTimelineProjection(timelineFile);
  } catch (error) {
    writeJsonAtomic(timelineFile, before);
    throw new Error(`Command 破坏 Timeline 合同，已恢复：${error.message}`);
  }
  const afterSnapshot = writeSnapshot(paths, after);
  const afterSha256 = sha256File(timelineFile);
  if (afterSha256 !== afterSnapshot.sha256) {
    writeJsonAtomic(timelineFile, before);
    throw new Error("Command 写入后检测到并发变化，Timeline 已恢复");
  }
  return {
    beforeSha256,
    afterSha256,
    beforeSnapshot,
    afterSnapshot,
    inverseOperations,
  };
}

export function openEditorProject(timelineFile, { includeSourceHash = false } = {}) {
  const { session, paths, projection } = loadOrCreateSession(timelineFile, { includeSourceHash });
  const timelineSha256 = sha256File(session.timelinePath);
  const synchronized = timelineSha256 === session.currentSha256
    && timelineSha256 === projection.timeline.sha256;
  return {
    schemaVersion: "1.0",
    status: synchronized ? "pass" : "conflict",
    session: {
      sessionId: session.sessionId,
      timelinePath: session.timelinePath,
      currentSha256: session.currentSha256,
      timelineSha256,
      synchronized,
      timebase: session.timebase ?? projection.timebase,
      canUndo: session.undoStack.length > 0,
      canRedo: session.redoStack.length > 0,
    },
    projection,
    journal: paths.journal,
  };
}

export function applyEditorCommand(timelineFile, command) {
  const resolved = resolveTimelinePath(timelineFile);
  const requestedBaseSha256 = requiredMutationSha(command?.baseSha256);
  const { session, paths } = loadOrCreateSession(resolved);
  const release = acquireFileLock(paths.lock, { purpose: "editor-command" });
  try {
    validateRecordChain(readJournal(paths).records);
    const currentSha = assertCurrent(session, resolved, requestedBaseSha256);
    const projection = buildTimelineProjection(resolved);
    const compiled = command?.operation
      ? compileEditorOperation(projection, command)
      : compileProjectionCommand(projection, command);
    const existingRecords = readJournal(paths).records;
    if (command.commandId && existingRecords.some((entry) => entry.commandId === command.commandId)) {
      throw new Error(`commandId 已存在：${command.commandId}`);
    }
    const applied = applyOperationsToTimeline({
      timelineFile: resolved,
      operations: compiled.operations,
      expectedSha: currentSha,
      paths,
    });
    const commandId = command.commandId
      ?? `cmd-${sha256Value({ base: currentSha, operations: compiled.operations, at: now() }).slice(0, 20)}`;
    let appended;
    try {
      appended = appendRecord(paths, {
        schemaVersion: "1.0",
        action: "apply",
        commandId,
        at: now(),
        actor: auditText(command.actor, "agent", "actor"),
        reason: auditText(command.reason, "timeline adjustment", "reason"),
        itemId: command.itemId ?? null,
        operation: command.operation ?? "set",
        beforeSha256: applied.beforeSha256,
        afterSha256: applied.afterSha256,
        forwardOperations: compiled.operations,
        inverseOperations: applied.inverseOperations,
        affectedTracks: compiled.affectedTracks,
        requiredQc: compiled.requiredQc,
        snapshots: { before: applied.beforeSnapshot, after: applied.afterSnapshot },
      });
    } catch (error) {
      writeJsonAtomic(resolved, readJson(applied.beforeSnapshot.path));
      throw new Error(`Command journal 写入失败，Timeline 已恢复：${error.message}`);
    }
    session.currentSha256 = applied.afterSha256;
    session.updatedAt = now();
    session.undoStack.push(commandId);
    session.redoStack = [];
    try {
      writeJsonAtomic(paths.session, session, { mode: 0o600 });
    } catch (error) {
      writeJsonAtomic(resolved, readJson(applied.beforeSnapshot.path));
      restoreJournal(paths, appended.previous);
      throw new Error(`Editor session 写入失败，Timeline 与 journal 已恢复：${error.message}`);
    }
    return {
      schemaVersion: "1.0",
      status: "pass",
      commandId,
      recordDigest: appended.record.recordDigest,
      timelineSha256: applied.afterSha256,
      requiredQc: compiled.requiredQc,
      project: openEditorProject(resolved),
    };
  } finally {
    release();
  }
}

function replayStack(timelineFile, action, expectedCurrentSha256) {
  const resolved = resolveTimelinePath(timelineFile);
  const requestedBaseSha256 = requiredMutationSha(expectedCurrentSha256, "expectedCurrentSha256");
  const { session, paths } = loadOrCreateSession(resolved);
  const release = acquireFileLock(paths.lock, { purpose: `editor-${action}` });
  try {
    const currentSha = assertCurrent(session, resolved, requestedBaseSha256);
    const { records } = readJournal(paths);
    validateRecordChain(records);
    const sourceStack = action === "undo" ? session.undoStack : session.redoStack;
    const destinationStack = action === "undo" ? session.redoStack : session.undoStack;
    const commandId = sourceStack.at(-1);
    if (!commandId) throw new Error(`没有可${action === "undo" ? "撤销" : "重做"}的 command`);
    const original = commandRecord(records, commandId);
    const operations = action === "undo" ? original.inverseOperations : original.forwardOperations;
    const applied = applyOperationsToTimeline({
      timelineFile: resolved,
      operations,
      expectedSha: currentSha,
      paths,
    });
    sourceStack.pop();
    destinationStack.push(commandId);
    let appended;
    try {
      appended = appendRecord(paths, {
        schemaVersion: "1.0",
        action,
        commandId,
        at: now(),
        actor: "editor-history",
        reason: `${action} ${commandId}`,
        itemId: original.itemId,
        beforeSha256: applied.beforeSha256,
        afterSha256: applied.afterSha256,
        forwardOperations: operations,
        affectedTracks: original.affectedTracks,
        requiredQc: original.requiredQc,
        snapshots: { before: applied.beforeSnapshot, after: applied.afterSnapshot },
      });
    } catch (error) {
      writeJsonAtomic(resolved, readJson(applied.beforeSnapshot.path));
      throw new Error(`Command journal 写入失败，Timeline 已恢复：${error.message}`);
    }
    session.currentSha256 = applied.afterSha256;
    session.updatedAt = now();
    try {
      writeJsonAtomic(paths.session, session, { mode: 0o600 });
    } catch (error) {
      writeJsonAtomic(resolved, readJson(applied.beforeSnapshot.path));
      restoreJournal(paths, appended.previous);
      throw new Error(`Editor session 写入失败，Timeline 与 journal 已恢复：${error.message}`);
    }
    return {
      schemaVersion: "1.0",
      status: "pass",
      action,
      commandId,
      recordDigest: appended.record.recordDigest,
      timelineSha256: applied.afterSha256,
      project: openEditorProject(resolved),
    };
  } finally {
    release();
  }
}

export function undoEditorCommand(timelineFile, expectedCurrentSha256) {
  return replayStack(timelineFile, "undo", expectedCurrentSha256);
}

export function redoEditorCommand(timelineFile, expectedCurrentSha256) {
  return replayStack(timelineFile, "redo", expectedCurrentSha256);
}

export function recoverEditorProject(
  timelineFile,
  { expectedCurrentSha256, actor = "editor-recovery", reason = "restore last valid snapshot" } = {},
) {
  const state = existingSession(timelineFile);
  if (!state) throw new Error("Editor session 不存在，无法执行快照恢复");
  const { resolved, paths, session } = state;
  const release = acquireFileLock(paths.lock, { purpose: "editor-recovery" });
  try {
    const beforeSha256 = sha256File(resolved);
    expectedSha(expectedCurrentSha256, beforeSha256);
    const parsed = readJournalPrefix(paths);
    const chained = validRecordPrefix(parsed.records);
    let records = [...chained.records];
    let stacks;
    let semanticError = null;
    while (true) {
      try {
        stacks = reconstructStacks(records);
        break;
      } catch (error) {
        semanticError = error.message;
        if (records.length === 0) throw error;
        records.pop();
      }
    }
    const last = records.at(-1);
    const snapshot = safeSnapshot(paths, last?.snapshots?.after ?? session.initialSnapshot);
    if (last?.afterSha256 && sha256File(snapshot.reference.path) !== last.afterSha256) {
      throw new Error("最后有效 journal 记录与恢复快照 SHA 不一致");
    }
    const archive = archiveEditorState(paths, resolved, "recover");
    try {
      writeJsonAtomic(resolved, snapshot.value);
      buildTimelineProjection(resolved);
      writeJournalRecords(paths, records);
      const afterSha256 = sha256File(resolved);
      const appended = appendRecord(paths, {
        schemaVersion: "1.0",
        action: "recover",
        commandId: `recovery-${sha256Value({ beforeSha256, afterSha256, at: now() }).slice(0, 20)}`,
        at: now(),
        actor: auditText(actor, "editor-recovery", "actor"),
        reason: auditText(reason, "restore last valid snapshot", "reason"),
        itemId: null,
        beforeSha256,
        afterSha256,
        forwardOperations: [],
        affectedTracks: [],
        requiredQc: ["timeline_validate", "affected_scope_review"],
        snapshots: { after: snapshot.reference },
        recovery: {
          archive,
          parseError: parsed.parseError,
          chainError: chained.error,
          semanticError,
          retainedRecords: records.length,
        },
      });
      session.currentSha256 = afterSha256;
      session.updatedAt = now();
      session.undoStack = stacks.undoStack;
      session.redoStack = stacks.redoStack;
      session.recoveryCount = Number(session.recoveryCount ?? 0) + 1;
      writeJsonAtomic(paths.session, session, { mode: 0o600 });
      return {
        schemaVersion: "1.0",
        status: "pass",
        action: "recover",
        archive,
        retainedRecords: records.length,
        recordDigest: appended.record.recordDigest,
        timelineSha256: afterSha256,
        project: openEditorProject(resolved),
      };
    } catch (error) {
      restoreArchivedState(archive, paths, resolved);
      throw new Error(`Editor 恢复失败，原状态已还原：${error.message}`);
    }
  } finally {
    release();
  }
}

export function reopenEditorProject(
  timelineFile,
  { expectedCurrentSha256, actor = "editor-user", reason = "accept external timeline state" } = {},
) {
  const resolved = resolveTimelinePath(timelineFile);
  const paths = statePaths(resolved);
  const release = acquireFileLock(paths.lock, { purpose: "editor-reopen" });
  try {
    const currentSha256 = sha256File(resolved);
    expectedSha(expectedCurrentSha256, currentSha256);
    const projection = buildTimelineProjection(resolved);
    const archive = archiveEditorState(paths, resolved, "reopen");
    try {
      fs.mkdirSync(paths.snapshots, { recursive: true });
      if (fs.existsSync(paths.journal)) fs.unlinkSync(paths.journal);
      if (fs.existsSync(paths.recovery)) fs.unlinkSync(paths.recovery);
      const timestamp = now();
      const session = {
        schemaVersion: "1.0",
        kind: "kacha-editor-session",
        sessionId: `editor-${sha256Value({ timeline: resolved, createdAt: timestamp }).slice(0, 20)}`,
        timelinePath: resolved,
        openedIdentity: fileIdentity(resolved),
        currentSha256,
        timebase: projection.timebase,
        createdAt: timestamp,
        updatedAt: timestamp,
        reopenedBy: auditText(actor, "editor-user", "actor"),
        reopenReason: auditText(reason, "accept external timeline state", "reason"),
        initialSnapshot: writeSnapshot(paths, readJson(resolved)),
        undoStack: [],
        redoStack: [],
      };
      writeJsonAtomic(paths.session, session, { mode: 0o600 });
      return {
        schemaVersion: "1.0",
        status: "pass",
        action: "reopen",
        archive,
        project: openEditorProject(resolved),
      };
    } catch (error) {
      restoreArchivedState(archive, paths, resolved);
      throw new Error(`Editor 重开失败，原状态已还原：${error.message}`);
    }
  } finally {
    release();
  }
}

export function editorHistory(timelineFile) {
  const resolved = resolveTimelinePath(timelineFile);
  const loaded = existingSession(resolved) ?? loadOrCreateSession(resolved);
  const { session, paths } = loaded;
  const parsed = readJournalPrefix(paths);
  const chained = validRecordPrefix(parsed.records);
  const records = parsed.records;
  const truncated = parsed.truncated;
  const chainStatus = parsed.parseError || chained.error ? "invalid" : "valid";
  const error = parsed.parseError ?? chained.error;
  const currentSha256 = sha256File(resolved);
  const status = truncated || chainStatus !== "valid" || currentSha256 !== session.currentSha256
    ? "recovery_required"
    : "pass";
  const recovery = {
    schemaVersion: "1.0",
    status,
    timelinePath: resolved,
    timelineSha256: currentSha256,
    sessionSha256: session.currentSha256,
    validRecords: chained.records.length,
    invalidLine: parsed.invalidLine,
    truncated,
    chainStatus,
    error,
    recommendedAction: status === "pass" ? "none" : "restore_last_valid_snapshot_or_reopen",
    observedAt: now(),
  };
  writeJsonAtomic(paths.recovery, recovery, { mode: 0o600 });
  return {
    ...recovery,
    canUndo: session.undoStack.length > 0,
    canRedo: session.redoStack.length > 0,
    records: records.map((record) => ({
      action: record.action,
      commandId: record.commandId,
      at: record.at,
      actor: record.actor,
      reason: record.reason,
      beforeSha256: record.beforeSha256,
      afterSha256: record.afterSha256,
      affectedTracks: record.affectedTracks,
      requiredQc: record.requiredQc,
      operation: record.operation ?? "set",
      recordDigest: record.recordDigest,
    })),
  };
}
