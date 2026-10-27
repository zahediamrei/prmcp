#!/usr/bin/env node
// Checks in-place media replacement on template clips already on the timeline.
// Expects the active sequence to have: V2 = a template clip used once,
// V4 = two clips of a template that other clips also use.
//   node scripts/test-replace-media.mjs <imageA> <imageB> <outDir>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [imageA, imageB, outDir] = process.argv.slice(2);
const client = new Client({ name: "replace-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "server.js")] }));

async function call(name, args = {}, quiet = false) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (!quiet || res.isError) console.log(`${res.isError ? "FAIL" : "PASS"} ${name}: ${text.replace(/\s+/g, " ").slice(0, 350)}`);
  if (res.isError) process.exitCode = 1;
  try { return JSON.parse(text); } catch { return text; }
}

async function soloFrame(track, time, file) {
  const seq = await call("get_active_sequence", {}, true);
  for (const t of seq.video) await call("set_track_muted", { trackType: "video", trackIndex: t.index, muted: t.index !== track }, true);
  await call("export_frame", { time, outputPath: join(outDir, file), returnImage: false }, true);
  for (const t of seq.video) await call("set_track_muted", { trackType: "video", trackIndex: t.index, muted: false }, true);
}

for (let i = 0; i < 60; i++) {
  const s = await client.callTool({ name: "get_status", arguments: {} });
  if (JSON.parse(s.content[0].text).connected) break;
  await new Promise((r) => setTimeout(r, 1000));
}

await call("get_mogrt_media", { trackIndex: 1, clipIndex: 0 });
// 1) template used by one clip: true in-place
await call("replace_mogrt_media", { trackIndex: 1, clipIndex: 0, replacements: [{ slot: "IMG Main", image: imageA }] });
await soloFrame(1, 3, "replace_unique.png");
// 2) shared template: only this clip
await call("get_mogrt_media", { trackIndex: 3, clipIndex: 1 });
await call("replace_mogrt_media", { trackIndex: 3, clipIndex: 1, replacements: [{ slot: "IMG Main", image: imageB }] });
await call("get_timeline_clips", { trackType: "video", trackIndex: 3 });
await soloFrame(3, 14, "replace_shared_changed.png");
await soloFrame(3, 3, "replace_shared_untouched.png");
await client.close();
