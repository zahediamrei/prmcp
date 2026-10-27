// End-to-end test of the safety layer (clip IDs, change reports, manual-edit detection,
// checkpoints, dry runs): the real MCP server and the panel's real JSX, on a mock Premiere.
// Run after `npm run build`: npm run test:safety
import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert/strict";
import { build, connectPanel } from "./mock-premiere.mjs";

import { fileURLToPath } from "url";
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "prmcp-home-"));
const transport = new StdioClientTransport({
  command: "node",
  args: [`${REPO}/dist/server.js`],
  env: { ...process.env, HOME: home, APPDATA: path.join(home, "AppData") },
  stderr: "ignore",
});
const client = new Client({ name: "test", version: "0" });
await client.connect(transport);

const { ctx, project, manualEdit } = build();
const keyFile = path.join(home, "AppData", "Premiere Connector", "key");
for (let i = 0; i < 50 && !fs.existsSync(keyFile); i++) await new Promise((r) => setTimeout(r, 100));
const panel = await connectPanel(8095, keyFile, ctx);

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const texts = r.content.filter((c) => c.type === "text").map((c) => c.text);
  const parsed = texts.map((t) => { try { return JSON.parse(t); } catch { return t; } });
  return { isError: !!r.isError, main: parsed[0], note: parsed[1], all: parsed };
}
const names = () => project.sequences.map((s) => s.name);
const clips = (seq = project.activeSequence) =>
  [...seq.videoTracks, ...seq.audioTracks].map((t) => t.clips.map((c) => `${c.name}@${Math.round(Number(c.start.ticks) / 254016000000 * 100) / 100}-${Math.round(Number(c.end.ticks) / 254016000000 * 100) / 100}`).join(","));
let passed = 0;
const ok = (msg) => { passed++; console.log("  ✓", msg); };

// schema: tools advertise the new params
const { tools } = await client.listTools();
const tool = (n) => tools.find((t) => t.name === n);
assert.ok(tool("ripple_delete_range").inputSchema.properties.dry_run);
assert.ok(tool("ripple_delete_range").inputSchema.properties.checkpoint);
assert.ok(tool("remove_clip").inputSchema.properties.clipId);
assert.ok(!(tool("remove_clip").inputSchema.required || []).includes("clipIndex"));
assert.ok(tool("link_clips").inputSchema.properties.clips.items.properties.clipId);
assert.ok(tool("set_clip_volume").inputSchema.properties.clipId);
assert.ok(!tool("get_timeline_clips").inputSchema.properties.dry_run);
ok(`schemas: ${tools.length} tools, clipId/dry_run/checkpoint added where expected`);

// 1. clip IDs are listed
let r = await call("get_timeline_clips");
const interview = r.main.clips.find((c) => c.name === "interview" && c.trackType === "video");
assert.ok(interview.clipId);
ok("get_timeline_clips returns clipId");

// 2. dry run: nothing changes, report of what would
const before = JSON.stringify(clips());
const seqCount = project.sequences.length;
r = await call("ripple_delete_range", { start: 5, end: 12, dry_run: true });
assert.equal(r.isError, false, JSON.stringify(r.all));
const dry = r.all.find((x) => x && x.dryRun);
assert.ok(dry, JSON.stringify(r.all));
assert.equal(JSON.stringify(clips()), before, "dry run must not change the timeline");
assert.equal(project.sequences.length, seqCount, "preview copy must be deleted");
assert.equal(project.activeSequence.name, "Main");
assert.ok(dry.wouldChange.some((l) => l.includes("removed")), JSON.stringify(dry));
assert.ok(dry.wouldChange.some((l) => l.includes(`[${interview.clipId}]`)), "preview IDs mapped to the original's: " + JSON.stringify(dry.wouldChange));
ok("dry_run: timeline untouched, preview deleted, would-change list uses real clip IDs");
console.log("     ", dry.wouldChange.join("\n       "));

// 3. real ripple: checkpoint taken + change report
r = await call("ripple_delete_range", { start: 5, end: 12 });
assert.equal(r.isError, false, JSON.stringify(r.all));
assert.ok(r.note.checkpoint && r.note.checkpoint.startsWith("Main · before ripple delete range"), JSON.stringify(r.note));
assert.ok(r.note.changes.length > 0);
assert.ok(names().includes(r.note.checkpoint));
const cpSeq = project.sequences.find((s) => s.name === r.note.checkpoint);
assert.equal(cpSeq.projectItem.bin.name, "prmcp checkpoints");
assert.equal(JSON.stringify(clips(cpSeq)), before, "checkpoint holds the pre-edit timeline");
const afterRipple = JSON.stringify(clips());
assert.notEqual(afterRipple, before);
ok("ripple_delete_range: checkpoint in its bin with the old timeline, changes reported");
console.log("      ", r.note.changes.join("\n       "));

// 4. clipId still points at the same clip after the edit changed its index/position
const pieces = project.activeSequence.videoTracks[0].clips;
const second = pieces[1]; // the interview piece after the ripple, now at index 1
const id2 = second.nodeId;
r = await call("move_clip", { clipId: id2, newStart: 40 });
assert.equal(r.isError, false, JSON.stringify(r.all));
assert.ok(r.note.changes.some((l) => l.includes(`[${id2}]`) && l.includes("→ V1 40")), JSON.stringify(r.note));
r = await call("rename_clip", { clipId: id2, newName: "interview B" });
assert.equal(r.isError, false, JSON.stringify(r.all));
assert.ok(project.activeSequence.videoTracks[0].clips.some((c) => c.nodeId === id2 && c.name === "interview B"));
assert.ok(r.note.changes.some((l) => l.includes('renamed from "interview"')), JSON.stringify(r.note));
ok("clipId follows a clip after it moved; move and rename reported");

// 5. manual edit is noticed by the next edit
manualEdit();
r = await call("set_clip_enabled", { clipId: id2, enabled: false });
assert.ok(r.note.changedOutsidePrmcp && r.note.changedOutsidePrmcp.some((l) => l.includes("music")), JSON.stringify(r.note));
ok("manual edit in Premiere reported as changedOutsidePrmcp");
console.log("      ", r.note.changedOutsidePrmcp.join("\n       "));

// 6. no false alarm on the following edit
r = await call("set_clip_enabled", { clipId: id2, enabled: true });
assert.ok(!r.note.changedOutsidePrmcp, JSON.stringify(r.note));
ok("no false manual-edit report afterwards");

// 7. restore_checkpoint puts the old timeline back in one step
r = await call("restore_checkpoint", { checkpoint: cpSeq.name });
assert.equal(r.isError, false, JSON.stringify(r.all));
assert.equal(project.activeSequence.name, "Main");
assert.equal(JSON.stringify(clips()), before);
assert.equal(project.activeSequence.projectItem.bin, project.rootItem, "restored sequence goes back to the original bin");
assert.ok(names().some((n) => n.startsWith("Main · replaced")));
ok("restore_checkpoint: one step back to the pre-ripple timeline, edited version kept");

// 8. failure halfway: automatic rollback
const beforeFail = JSON.stringify(clips());
r = await call("slide_clip", { trackType: "video", trackIndex: 0, clipIndex: 0, offset: 1 });
assert.equal(r.isError, true);
const errText = r.all.join(" ");
assert.ok(errText.includes("rolled back"), errText);
assert.equal(JSON.stringify(clips()), beforeFail, "timeline restored after the failed edit");
assert.equal(project.activeSequence.name, "Main");
ok("failed edit rolled back automatically");

// 9. bad clipId gives a helpful error; audio tool rejects a video clipId
r = await call("remove_clip", { clipId: "nope" });
assert.ok(r.isError && r.all.join(" ").includes("No clip with clipId"), JSON.stringify(r.all));
const v0 = project.activeSequence.videoTracks[0].clips[0].nodeId;
r = await call("set_clip_volume", { clipId: v0, volumeDb: -6 });
assert.ok(r.isError && r.all.join(" ").includes("needs an audio clip"), JSON.stringify(r.all));
r = await call("remove_clip", {});
assert.ok(r.isError && r.all.join(" ").includes("clipId"), JSON.stringify(r.all));
ok("clear errors for unknown clipId, wrong track type, missing clip");

// 10. pruning keeps at most 10 checkpoints per sequence
for (let i = 0; i < 12; i++) await call("close_gaps", {});
r = await call("list_checkpoints");
const mainCps = (Array.isArray(r.main) ? r.main : []).filter((c) => c.name.startsWith("Main · before"));
assert.ok(mainCps.length <= 10, `has ${mainCps.length}`);
ok(`checkpoints pruned to ${mainCps.length}`);

// 11. checkpoint=false skips it
const n0 = project.sequences.length;
r = await call("close_gaps", { checkpoint: false });
assert.equal(project.sequences.length, n0);
assert.ok(!r.note.checkpoint);
ok("checkpoint=false skips the copy");

// 12. link_clips with clipIds in the array
let linked = null;
ctx.linkClips = (arr) => { linked = arr; return { linked: arr.length }; };
const a0 = project.activeSequence.audioTracks[0].clips[0].nodeId;
r = await call("link_clips", { clips: [{ clipId: v0 }, { clipId: a0 }] });
assert.equal(r.isError, false, JSON.stringify(r.all));
assert.equal(JSON.stringify(linked.map((c) => [c.trackType, c.trackIndex, c.clipIndex])), JSON.stringify([["video", 0, 0], ["audio", 0, 0]]));
ok("clipIds inside clip arrays resolved");

// 13. clear_checkpoints only removes that bin
r = await call("clear_checkpoints");
assert.ok(names().every((n) => !n.includes(" · ")), names().join(" | "));
assert.ok(names().includes("Main"));
ok("clear_checkpoints empties the bin, leaves Main");

// 14. undo right after a dry run warns that prmcp's own steps are in the history
ctx.undo = () => ({ undone: 1 });
await call("close_gaps", { dry_run: true });
r = await call("undo", {});
assert.ok(r.note && String(r.note.warning).includes("a dry run"), JSON.stringify(r.all));
r = await call("undo", {});
assert.ok(!r.note || !r.note.warning, JSON.stringify(r.all));
ok("undo after a dry run carries a warning, only once");

// 15. dry run refuses to edit if the preview copy doesn't open
const realOpen = project.openSequence;
project.openSequence = function (id) { if (this.sequences.find((s) => s.sequenceID === id)?.name.includes("preview")) return false; return realOpen.call(this, id); };
const beforeRefuse = JSON.stringify(clips());
const seqsBefore = project.sequences.length;
r = await call("ripple_delete_range", { start: 0, end: 2, dry_run: true });
assert.ok(r.isError && r.all.join(" ").includes("preview copy"), JSON.stringify(r.all));
assert.equal(JSON.stringify(clips()), beforeRefuse, "the real sequence must not be edited");
assert.equal(project.sequences.length, seqsBefore, "the copy is cleaned up");
project.openSequence = realOpen;
ok("dry run stops, untouched, when the preview copy can't be opened");

// 16. a missing address field is named in the error
r = await call("remove_clip", { trackIndex: 0, clipIndex: 0 });
assert.ok(r.isError && r.all.join(" ").includes("missing trackType"), JSON.stringify(r.all));
ok("missing trackType reported by name");

console.log(`\n${passed} checks passed`);
panel.close();
await client.close();
process.exit(0);
