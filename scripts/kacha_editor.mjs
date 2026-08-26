#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { readJson } from "./kacha_utils.mjs";
import {
  applyEditorCommand,
  editorHistory,
  openEditorProject,
  recoverEditorProject,
  reopenEditorProject,
  redoEditorCommand,
  undoEditorCommand,
} from "./editor_command_journal.mjs";
import { buildTimelineProjection } from "./timeline_projection.mjs";
import {
  assertPreviewProviderEligibility,
  listPreviewProviders,
} from "./preview_provider.mjs";

const args = process.argv.slice(2);
const action = args[0];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function timelineOption() {
  const value = option("--timeline");
  if (!value) fail("--timeline 不能为空", 2);
  return path.resolve(value);
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

if (["inspect", "project", "query", "history"].includes(action)) {
  const timeline = timelineOption();
  if (action === "inspect") {
    const projection = buildTimelineProjection(timeline);
    print({
      schemaVersion: "1.0",
      status: "pass",
      projectId: projection.projectId,
      timeline: projection.timeline,
      timebase: projection.timebase,
      durationTick: projection.durationTick,
      durationSeconds: projection.durationSeconds,
      tracks: projection.tracks.map((track) => ({
        id: track.id,
        type: track.type,
        items: track.itemIds.length,
      })),
      projectionDigest: projection.digest,
    });
  } else if (action === "project") {
    print(openEditorProject(timeline));
  } else if (action === "history") {
    print(editorHistory(timeline));
  } else {
    const projection = buildTimelineProjection(timeline);
    const track = option("--track");
    const type = option("--type");
    const item = option("--item");
    const items = projection.items.filter((candidate) => (
      (!track || candidate.trackId === track)
      && (!type || candidate.type === type)
      && (!item || candidate.id === item)
    ));
    print({
      schemaVersion: "1.0",
      status: "pass",
      filters: { track, type, item },
      returned: items.length,
      items,
    });
  }
  process.exit(0);
}

if (action === "command") {
  const commandAction = args[1];
  const timeline = timelineOption();
  if (commandAction === "apply") {
    const commandFile = option("--command");
    if (!commandFile || !fs.existsSync(commandFile)) fail("--command 文件不存在", 2);
    print(applyEditorCommand(timeline, readJson(path.resolve(commandFile))));
  } else if (commandAction === "undo") {
    print(undoEditorCommand(timeline));
  } else if (commandAction === "redo") {
    print(redoEditorCommand(timeline));
  } else {
    fail("editor command 只支持 apply|undo|redo", 2);
  }
  process.exit(0);
}

if (["recover", "reopen"].includes(action)) {
  const timeline = timelineOption();
  const expectedCurrentSha256 = option("--expected-sha");
  if (!expectedCurrentSha256) fail(`${action} 必须提供 --expected-sha`, 2);
  const options = {
    expectedCurrentSha256,
    actor: option("--actor", "editor-user"),
    reason: option(
      "--reason",
      action === "recover" ? "restore last valid snapshot" : "accept external timeline state",
    ),
  };
  print(action === "recover"
    ? recoverEditorProject(timeline, options)
    : reopenEditorProject(timeline, options));
  process.exit(0);
}

if (action === "preview-capabilities") {
  print(listPreviewProviders());
  process.exit(0);
}

if (action === "preview-eligibility") {
  const provider = option("--provider");
  const purpose = option("--purpose", "preview");
  if (!provider || !["preview", "final"].includes(purpose)) {
    fail("preview-eligibility 需要 --provider 和 --purpose preview|final", 2);
  }
  try {
    print({ schemaVersion: "1.0", status: "pass", ...assertPreviewProviderEligibility(provider, { purpose }) });
  } catch (error) {
    fail(JSON.stringify({ schemaVersion: "1.0", status: "blocked", error: error.message }, null, 2));
  }
  process.exit(0);
}

fail(
  "用法：kacha editor inspect|project|query|history --timeline FILE\n"
    + "  kacha editor command apply|undo|redo --timeline FILE [--command FILE]\n"
    + "  kacha editor recover|reopen --timeline FILE --expected-sha SHA [--actor NAME --reason TEXT]\n"
    + "  kacha editor preview-capabilities\n"
    + "  kacha editor preview-eligibility --provider ID --purpose preview|final",
  2,
);
