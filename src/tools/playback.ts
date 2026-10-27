import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../bridge.js";

export function registerPlaybackTools(server: McpServer) {
  server.tool("set_playhead", "Move the playhead", { time: z.number().min(0).describe("Seconds") }, ({ time }) =>
    run("setPlayhead", [time])
  );

  server.tool("get_playhead", "Current playhead time (seconds)", {}, () => run("getPlayhead"));

  server.tool(
    "go_to_edit",
    "Move the playhead to the next/previous edit point",
    { direction: z.enum(["next", "previous"]) },
    ({ direction }) => run("goToEdit", [direction])
  );

  server.tool(
    "play",
    "Start playback in the Program Monitor",
    { speed: z.number().optional().describe("1 = normal, 2 = double, -1 = reverse") },
    ({ speed }) => run("playSequence", [speed ?? 1])
  );

  server.tool("stop", "Stop playback", {}, () => run("stopPlayback"));

  server.tool("open_in_source_monitor", "Open a project item in the Source Monitor", { nodeId: z.string() }, ({ nodeId }) =>
    run("openInSourceMonitor", [nodeId])
  );

  server.tool("get_source_monitor", "What is open in the Source Monitor", {}, () => run("getSourceMonitor"));

  server.tool("get_workspaces", "Names of the available workspaces", {}, () => run("getWorkspaces"));

  server.tool("set_workspace", "Switch workspace (e.g. Editing, Color, Audio)", { name: z.string() }, ({ name }) =>
    run("setWorkspace", [name])
  );

  server.tool(
    "undo",
    "Undo the last action(s) in Premiere Pro (one tool call can be several undo steps)",
    { steps: z.number().int().min(1).max(50).optional() },
    ({ steps }) => run("undo", [steps ?? 1])
  );

  server.tool("redo", "Redo undone action(s)", { steps: z.number().int().min(1).max(50).optional() }, ({ steps }) =>
    run("redo", [steps ?? 1])
  );
}
