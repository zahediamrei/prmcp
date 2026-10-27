#!/usr/bin/env node
// End-to-end check: starts the MCP server over stdio (like Claude does) and
// runs an editing scenario against the open Premiere project.
// WARNING: it edits the ACTIVE project. Run it on a scratch project only.
//   node scripts/e2e-test.mjs <clipA nodeId> <clipB nodeId> [outDir]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { tmpdir } from "os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [clipA, clipB, outDir = tmpdir()] = process.argv.slice(2);
if (!clipA || !clipB) {
  console.error("usage: e2e-test.mjs <clipA nodeId> <clipB nodeId> [outDir]");
  process.exit(2);
}

const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "server.js")] }));

let failures = 0;
async function call(name, args = {}, expectError = false) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const images = res.content.filter((c) => c.type === "image").length;
  const ok = !!res.isError === expectError;
  if (!ok) failures++;
  const short = text.replace(/\s+/g, " ").slice(0, 220);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${images ? ` [${images} image]` : ""}: ${short}`);
  try { return JSON.parse(text); } catch { return text; }
}

const tools = await client.listTools();
console.log(`tools: ${tools.tools.length}`);

// Wait for the panel to connect to this server.
for (let i = 0; i < 30; i++) {
  const s = await client.callTool({ name: "get_status", arguments: {} });
  if (JSON.parse(s.content[0].text).connected) break;
  await new Promise((r) => setTimeout(r, 1000));
}

await call("get_status");
await call("create_sequence", { name: "E2E " + Date.now(), width: 1920, height: 1080, fps: 25 });
await call("append_clip", { nodeId: clipA, sourceIn: 0, sourceOut: 6 });
await call("append_clip", { nodeId: clipB, sourceIn: 0, sourceOut: 4 });
await call("razor_all_tracks", { time: 3 });
await call("ripple_delete_range", { start: 1, end: 2 });
let tl = await call("get_timeline_clips", { trackType: "video" });
console.log("   video:", tl.clips.map((c) => `${c.name} ${c.start}-${c.end} src ${c.sourceIn}-${c.sourceOut}`).join(" | "));
await call("set_clip_speed", { trackType: "video", trackIndex: 0, clipIndex: 1, speed: 2, ripple: true });
await call("apply_transition", { trackType: "video", trackIndex: 0, clipIndex: 0, position: "end", duration: 0.5 });
await call("apply_effect", { trackType: "video", trackIndex: 0, clipIndex: 0, effectName: "Gaussian Blur" });
await call("set_clip_transform", { trackIndex: 0, clipIndex: 0, scale: 100, time: 0 });
await call("set_clip_transform", { trackIndex: 0, clipIndex: 0, scale: 130, time: 1.9 });
await call("set_keyframe_interpolation", { trackType: "video", trackIndex: 0, clipIndex: 0, effect: "Motion", property: "Scale", keyframe: "all", interpolation: "bezier" });
await call("set_clip_volume", { trackIndex: 0, clipIndex: 0, volumeDb: -3 });
await call("fade_clip_volume", { trackIndex: 0, clipIndex: 1, fadeIn: 0.5, fadeOut: 0.5 });
await call("add_marker", { time: 1, name: "Check", color: "red" });
await call("add_text", { text: "Hello from Premiere Connector", start: 0, duration: 3, position: "bottom", backgroundColor: "#000000" });
await call("add_captions", { captions: [{ start: 0.2, end: 1.5, text: "First caption" }, { start: 1.6, end: 3, text: "Second caption" }] });
await call("add_text_captions", { captions: [{ start: 3, end: 4, text: "Word" }, { start: 4, end: 5, text: "by word" }], position: "center", strokeColor: "#000000", strokeWidth: 4 });
await call("get_active_sequence");
await call("export_frame", { time: 1, outputPath: join(outDir, "e2e_frame.png") });
await call("export_sequence", { outputPath: join(outDir, "e2e.mp4") });
await call("undo");
await call("get_export_presets", { filter: "youtube" });

// Errors must come back as errors with a useful message.
await call("get_clip_info", { trackType: "video", trackIndex: 9, clipIndex: 0 }, true);
await call("apply_effect", { trackType: "video", trackIndex: 0, clipIndex: 0, effectName: "blur" }, true);
await call("export_sequence", { outputPath: join(outDir, "x.mp4"), preset: "nonexistent preset" }, true);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
await client.close();
process.exit(failures ? 1 : 0);
