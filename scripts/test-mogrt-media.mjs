#!/usr/bin/env node
// Checks media replacement in a library graphic through the real MCP server.
//   node scripts/test-mogrt-media.mjs <library> <graphic> <image> [outDir]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { tmpdir } from "os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [library, graphic, image, outDir = tmpdir()] = process.argv.slice(2);
const client = new Client({ name: "mogrt-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "server.js")] }));

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`${res.isError ? "FAIL" : "PASS"} ${name}: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
  if (res.isError) process.exitCode = 1;
  try { return JSON.parse(text); } catch { return text; }
}

for (let i = 0; i < 60; i++) {
  const s = await client.callTool({ name: "get_status", arguments: {} });
  if (JSON.parse(s.content[0].text).connected) break;
  await new Promise((r) => setTimeout(r, 1000));
}
await call("list_library_graphics", { filter: graphic });
await call("get_mogrt_media", { library, graphic });
await call("set_track_muted", { trackType: "video", trackIndex: 0, muted: true });
await call("set_track_muted", { trackType: "video", trackIndex: 1, muted: true });
await call("add_tracks", { videoTracks: 1 });
const placed = await call("place_mogrt_with_media", {
  library, graphic, trackIndex: 2, start: 0, duration: 10,
  replacements: [{ slot: "IMG Main", image }],
  properties: { Text: "Image and text replaced by Premiere Connector" },
});
await call("export_frame", { time: 3, outputPath: join(outDir, "mogrt_media_test.png"), returnImage: false });
await call("set_track_muted", { trackType: "video", trackIndex: 0, muted: false });
await call("set_track_muted", { trackType: "video", trackIndex: 1, muted: false });
await client.close();
