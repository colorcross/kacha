#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readJson, sha256Value, writeJsonAtomic } from "./kacha_utils.mjs";

const MAX_JSONL_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS_PER_SOURCE = 20000;
const MAX_DIRECTORY_ENTRIES = 5000;
const MAX_TOTAL_EVENTS = 50000;

function redactText(value) {
  return String(value ?? "")
    .replace(/((?:authorization\s*:\s*)?(?:Bearer|Basic))\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/(["']?(?:api.?key|access.?token|refresh.?token|token|secret|password|credential)["']?\s*[:=]\s*)(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]");
}

function compact(value, maximum = 240) {
  let text;
  try { text = typeof value === "string" ? value : JSON.stringify(value); }
  catch { text = String(value ?? ""); }
  const redacted = redactText(text).replace(/[\r\n\t]+/g, " ").trim();
  return redacted.length > maximum ? `${redacted.slice(0, maximum)}…` : redacted || null;
}

function safeProjectFile(root, file, limitations) {
  if (!fs.existsSync(file)) return false;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      limitations.push(`symlink_source_rejected:${path.relative(root, file)}`);
      return false;
    }
    const real = fs.realpathSync(file);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
      limitations.push(`outside_project_rejected:${path.relative(root, file)}`);
      return false;
    }
    return fs.statSync(real).isFile();
  } catch {
    limitations.push(`unreadable_source:${path.relative(root, file)}`);
    return false;
  }
}

function readJsonLines(root, file, limitations) {
  if (!safeProjectFile(root, file, limitations)) return [];
  const stat = fs.statSync(file);
  let text;
  let tailOnly = false;
  if (stat.size > MAX_JSONL_BYTES) {
    const descriptor = fs.openSync(file, "r");
    const buffer = Buffer.alloc(MAX_JSONL_BYTES);
    try { fs.readSync(descriptor, buffer, 0, buffer.length, stat.size - buffer.length); }
    finally { fs.closeSync(descriptor); }
    text = buffer.toString("utf8");
    const newline = text.indexOf("\n");
    text = newline >= 0 ? text.slice(newline + 1) : "";
    tailOnly = true;
    limitations.push(`jsonl_tail_only:${path.basename(file)}:${stat.size}`);
  } else text = fs.readFileSync(file, "utf8");
  const result = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { result.push({ value: JSON.parse(line), line: tailOnly ? `tail-${index + 1}` : index + 1 }); }
    catch { limitations.push(`invalid_jsonl:${path.basename(file)}:${index + 1}`); }
  }
  if (result.length > MAX_EVENTS_PER_SOURCE) limitations.push(`event_limit:${path.basename(file)}:${MAX_EVENTS_PER_SOURCE}`);
  return result.slice(-MAX_EVENTS_PER_SOURCE);
}

function iso(value, fallback = null) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function eventId(source, ref, value) {
  return sha256Value({ source, ref, value }).slice(0, 20);
}

function projectEvents(root, limitations) {
  const file = path.join(root, ".kacha", "project-events.jsonl");
  return readJsonLines(root, file, limitations).map(({ value, line }) => {
    const ref = `${path.relative(root, file)}:${line}`;
    return {
      id: eventId("project", ref, value),
      at: iso(value.at ?? value.timing?.startedAt, new Date(0).toISOString()),
      type: value.type ?? value.stage ?? "project_event",
      status: value.status ?? value.state ?? null,
      source: "project",
      sourceRef: ref,
      subject: value.projectId ?? value.actionId ?? null,
      summary: value.diagnostics?.[0] ?? value.message ?? null
    };
  });
}

function metricEvents(root, limitations) {
  const candidates = [
    path.join(root, ".kacha", "metrics", "events.jsonl"),
    path.join(root, ".kacha", "metrics.jsonl")
  ];
  return candidates.flatMap((file) => readJsonLines(root, file, limitations).map(({ value, line }) => {
    const ref = `${path.relative(root, file)}:${line}`;
    return {
      id: eventId("telemetry", ref, value.eventId ?? value),
      at: iso(value.timing?.startedAt ?? value.at, new Date(0).toISOString()),
      type: value.stage ? `telemetry:${value.stage}` : "telemetry",
      status: value.status ?? null,
      source: "telemetry",
      sourceRef: ref,
      subject: value.workflow?.versionId ?? null,
      summary: value.cache?.status ? `cache=${value.cache.status}` : null
    };
  }));
}

function jobEvents(root, limitations) {
  const jobsRoot = path.join(root, ".kacha", "jobs");
  if (!fs.existsSync(jobsRoot)) return [];
  if (fs.lstatSync(jobsRoot).isSymbolicLink()) { limitations.push("symlink_directory_rejected:.kacha/jobs"); return []; }
  const result = [];
  const entries = fs.readdirSync(jobsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > MAX_DIRECTORY_ENTRIES) limitations.push(`directory_limit:.kacha/jobs:${MAX_DIRECTORY_ENTRIES}`);
  for (const entry of entries.slice(0, MAX_DIRECTORY_ENTRIES)) {
    const file = path.join(jobsRoot, entry.name, "job.json");
    if (!entry.isDirectory() || !safeProjectFile(root, file, limitations)) continue;
    try {
      const job = readJson(file);
      for (const [type, at, status] of [
        ["job:submitted", job.createdAt, "queued"],
        ["job:started", job.startedAt, "running"],
        [`job:${job.status ?? "unknown"}`, job.finishedAt ?? job.updatedAt, job.status]
      ]) {
        if (!at) continue;
        const ref = path.relative(root, file);
        result.push({
          id: eventId("job", `${ref}:${type}`, { id: job.id, at, status }),
          at: iso(at, new Date(0).toISOString()),
          type,
          status: status ?? null,
          source: "job",
          sourceRef: ref,
          subject: job.ref ?? job.id ?? entry.name,
          summary: job.kind ?? null
        });
      }
    } catch { limitations.push(`invalid_job:${path.relative(root, file)}`); }
  }
  return result;
}

function costEvents(root, limitations) {
  const file = path.join(root, ".kacha", "cost-ledger.json");
  if (!safeProjectFile(root, file, limitations)) return [];
  try {
    const ledger = readJson(file);
    return (ledger.events ?? []).map((value, index) => {
      const ref = `${path.relative(root, file)}:events[${index}]`;
      return {
        id: eventId("cost", ref, value.id ?? value),
        at: iso(value.at, new Date(0).toISOString()),
        type: `cost:${value.type ?? "event"}`,
        status: null,
        source: "cost",
        sourceRef: ref,
        subject: value.entryId ?? null,
        summary: value.detail?.amount === undefined ? null : `amount=${value.detail.amount} ${ledger.currency}`
      };
    });
  } catch { limitations.push(`invalid_cost_ledger:${path.relative(root, file)}`); return []; }
}

function decisionEvents(root, limitations) {
  const directory = path.join(root, ".kacha", "decisions");
  if (!fs.existsSync(directory)) return [];
  if (fs.lstatSync(directory).isSymbolicLink()) { limitations.push("symlink_directory_rejected:.kacha/decisions"); return []; }
  const result = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > MAX_DIRECTORY_ENTRIES) limitations.push(`directory_limit:.kacha/decisions:${MAX_DIRECTORY_ENTRIES}`);
  for (const entry of entries.slice(0, MAX_DIRECTORY_ENTRIES)) {
    if (!entry.isFile() || path.extname(entry.name) !== ".json") continue;
    const file = path.join(directory, entry.name);
    if (!safeProjectFile(root, file, limitations)) continue;
    try {
      const value = readJson(file);
      const ref = path.relative(root, file);
      result.push({
        id: eventId("decision", ref, value.decisionDigest ?? value),
        at: iso(value.decidedAt ?? value.createdAt, new Date(0).toISOString()),
        type: `decision:${value.kind ?? "unknown"}`,
        status: value.status ?? null,
        source: "decision",
        sourceRef: ref,
        subject: value.chosenProviderId ?? value.id ?? null,
        summary: value.request?.capability ?? value.mode ?? null
      });
    } catch { limitations.push(`invalid_decision:${path.relative(root, file)}`); }
  }
  return result;
}

export function buildFlightSnapshot(projectRoot) {
  const requestedRoot = path.resolve(projectRoot);
  if (!fs.existsSync(requestedRoot) || !fs.statSync(requestedRoot).isDirectory()) throw new Error(`project root does not exist: ${requestedRoot}`);
  const root = fs.realpathSync(requestedRoot);
  const limitations = [];
  let events = [
    ...projectEvents(root, limitations),
    ...metricEvents(root, limitations),
    ...jobEvents(root, limitations),
    ...costEvents(root, limitations),
    ...decisionEvents(root, limitations)
  ].map((event) => ({
    ...event,
    type: compact(event.type, 120) ?? "unknown",
    status: compact(event.status, 80),
    subject: compact(event.subject, 160),
    summary: compact(event.summary, 240)
  })).sort((left, right) => left.at.localeCompare(right.at) || left.source.localeCompare(right.source) || left.id.localeCompare(right.id));
  if (events.length > MAX_TOTAL_EVENTS) {
    limitations.push(`total_event_limit:${MAX_TOTAL_EVENTS}`);
    events = events.slice(-MAX_TOTAL_EVENTS);
  }
  const snapshot = {
    schemaVersion: "1.0",
    kind: "kacha-production-flight",
    status: limitations.length > 0 ? "limited" : "pass",
    projectRoot: root,
    generatedAt: new Date().toISOString(),
    sources: [...new Set(events.map((event) => event.source))],
    counts: Object.fromEntries([...new Set(events.map((event) => event.source))].map((source) => [source, events.filter((event) => event.source === source).length])),
    limitations,
    events
  };
  snapshot.snapshotDigest = sha256Value({ projectRoot: snapshot.projectRoot, sources: snapshot.sources, counts: snapshot.counts, limitations, events });
  return snapshot;
}

export function validateFlightSnapshot(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["flight snapshot root must be an object"];
  if (value.schemaVersion !== "1.0" || value.kind !== "kacha-production-flight") errors.push("invalid snapshot identity");
  if (!Array.isArray(value.events)) errors.push("events must be an array");
  const ids = new Set();
  let previous = "";
  for (const event of value.events ?? []) {
    if (!event.id || ids.has(event.id)) errors.push(`duplicate or missing event id: ${event.id}`);
    ids.add(event.id);
    if (!event.at || event.at < previous) errors.push(`events are not ordered at ${event.id}`);
    if (!event.at || Number.isNaN(new Date(event.at).getTime()) || new Date(event.at).toISOString() !== event.at) errors.push(`event timestamp is invalid: ${event.id}`);
    previous = event.at ?? previous;
    if (!event.source || !event.sourceRef || !event.type) errors.push(`incomplete event: ${event.id}`);
    for (const field of ["type", "status", "subject", "summary"]) {
      if (event[field] && redactText(event[field]) !== event[field]) errors.push(`event contains unredacted sensitive text: ${event.id}.${field}`);
    }
  }
  const expectedSources = [...new Set((value.events ?? []).map((event) => event.source))];
  const expectedCounts = Object.fromEntries(expectedSources.map((source) => [source, value.events.filter((event) => event.source === source).length]));
  if (sha256Value(value.sources) !== sha256Value(expectedSources)) errors.push("sources do not match events");
  if (sha256Value(value.counts) !== sha256Value(expectedCounts)) errors.push("counts do not match events");
  const expectedDigest = sha256Value({ projectRoot: value.projectRoot, sources: value.sources, counts: value.counts, limitations: value.limitations, events: value.events });
  if (value.snapshotDigest !== expectedDigest) errors.push("snapshotDigest mismatch");
  return errors;
}

function cli() {
  const args = process.argv.slice(2);
  const action = args[0];
  const option = (name, fallback = null) => {
    const index = args.indexOf(name);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
  };
  const fail = (message, code = 1) => {
    console.error(JSON.stringify({ schemaVersion: "1.0", status: "blocked", error: message }, null, 2));
    process.exit(code);
  };
  if (!new Set(["snapshot", "replay", "validate"]).has(action)) fail("usage: kacha.mjs flight snapshot|replay|validate [options]", 2);
  if (action === "snapshot") {
    const root = option("--project-root", process.cwd());
    const output = option("--output", path.join(path.resolve(root), ".kacha", "flight", "snapshot.json"));
    const snapshot = buildFlightSnapshot(root);
    writeJsonAtomic(output, snapshot);
    console.log(JSON.stringify({ schemaVersion: "1.0", status: snapshot.status, output: path.resolve(output), events: snapshot.events.length, counts: snapshot.counts, limitations: snapshot.limitations, snapshotDigest: snapshot.snapshotDigest }, null, 2));
    return;
  }
  const input = option("--input");
  if (!input) fail(`${action} requires --input`, 2);
  const value = readJson(path.resolve(input));
  const errors = validateFlightSnapshot(value);
  if (errors.length > 0) fail(errors.join("; "));
  if (action === "validate") {
    console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", input: path.resolve(input), events: value.events.length, digest: sha256Value(value) }, null, 2));
    return;
  }
  const after = option("--after");
  const type = option("--type");
  const source = option("--source");
  const limit = Number(option("--limit", 100));
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) fail("--limit must be 1..10000", 2);
  const events = value.events.filter((event) => (!after || event.at > after) && (!type || event.type === type) && (!source || event.source === source)).slice(0, limit);
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", snapshotDigest: value.snapshotDigest, filters: { after, type, source, limit }, events }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) cli();
