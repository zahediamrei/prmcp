import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, toolResult } from "../bridge.js";
import { createCheckpoint, forgetCheckpoints, restoreCheckpoint } from "../safety.js";

const seqRef = z.string().describe("Sequence name or ID");

export function registerSafetyTools(server: McpServer) {
  server.tool(
    "create_checkpoint",
    "Save a copy of the active sequence in the 'prmcp checkpoints' bin before a large edit. Premiere has no grouped undo for scripted edits; restore_checkpoint reverts everything since the checkpoint in one step. Risky tools (ripple_delete_range, close_gaps, ...) take one automatically. The newest 10 copies per sequence are kept.",
    { label: z.string().optional().describe("Short note, e.g. 'remove intro'") },
    async ({ label }) => toolResult(await createCheckpoint(label))
  );

  server.tool(
    "restore_checkpoint",
    "Put a checkpoint back in place of the sequence it was copied from (it takes that sequence's name and bin, and opens). The edited version is kept, renamed, in the checkpoints bin.",
    {
      checkpoint: seqRef.describe("Checkpoint name or ID (from the edit's result or list_checkpoints)"),
      target: seqRef.optional().describe("Sequence to replace (default: the open one)"),
    },
    async ({ checkpoint, target }) => toolResult(await restoreCheckpoint(checkpoint, target))
  );

  server.tool("list_checkpoints", "Sequences in the 'prmcp checkpoints' bin, oldest first", {}, () => run("listCheckpoints"));

  server.tool(
    "clear_checkpoints",
    "Delete every sequence in the 'prmcp checkpoints' bin (only that bin). Ask the user first: it removes the copies that make edits reversible.",
    {},
    async () => {
      const r = await run("clearCheckpoints");
      forgetCheckpoints();
      return r;
    }
  );
}
