import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "./bridge.js";
import { registerAllTools } from "./tools/index.js";

const instructions = `Tools for editing in Adobe Premiere Pro (the app must be open with the "Premiere Connector" panel).

How the timeline is addressed:
- Times are in seconds. Tracks are 0-based: V1 = video track 0, A1 = audio track 0.
- Prefer clipId (from get_timeline_clips) to address clips: it stays valid while other edits shift positions. trackType + trackIndex + clipIndex (0-based, left to right) also work, but indexes change after cuts, moves and deletes. A clip cut in two keeps its clipId on the left piece.
- Every edit returns "changes" (what it did to the timeline). If it also returns "changedOutsidePrmcp", the user edited the timeline by hand since your last call: take that into account.
- Most edits act on the active sequence (get_active_sequence / set_active_sequence).

Good workflow:
1. get_status, then get_active_sequence and get_timeline_clips to understand the edit.
2. Make changes. Video clips carry their linked audio along for moves, trims, speed and removal.
3. Check visual results with export_frame (it returns an image of the rendered frame).
4. If something went wrong: risky edits return a "checkpoint", and restore_checkpoint reverts the whole edit in one step (undo only goes back one scripted step at a time). Before a larger job, call create_checkpoint. Use dry_run: true to preview a structural edit without changing anything.

Notes:
- ripple_delete_range is the quickest way to cut a section out of everything; trim_clip / remove_clip leave gaps unless ripple is used; close_gaps closes them.
- add_text renders titles with the system text engine (right-to-left and complex scripts work) as images; add_captions creates real editable caption tracks.
- Text inside Premiere's own titles can't be scripted; After Effects .mogrt templates can (set_mogrt_property).
- Images in a template's media slots: replace_mogrt_media for a template clip already on the timeline (keeps it in place), place_mogrt_with_media to add a new one; get_mogrt_media lists the slot names. Works for After Effects .mogrt files and Creative Cloud Library graphics.`;

const server = new McpServer({ name: "premiere-connector", version: "1.0.0" }, { instructions });

registerAllTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Premiere Connector server running");

  // Exit with the Claude client that started us. Otherwise an orphaned server
  // keeps the panel's port and the next session can't reach Premiere.
  const quit = () => process.exit(0);
  process.stdin.on("end", quit);
  process.stdin.on("close", quit);
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      quit();
    }
    if (process.ppid !== parent) quit();
  }, 5000).unref();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
