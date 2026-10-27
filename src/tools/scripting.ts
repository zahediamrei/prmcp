import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../bridge.js";

export function registerScriptingTools(server: McpServer) {
  server.tool(
    "execute_extendscript",
    "Run raw ExtendScript in Premiere Pro for anything the other tools don't cover. The value of the last expression is returned (objects are JSON-encoded). `app`, `qe` (after app.enableQE()) and the helper functions of this bridge are available. Times in the DOM are Time objects/ticks (254016000000 per second).",
    {
      script: z.string(),
      enableQE: z.boolean().optional().describe("Call app.enableQE() first so `qe` is available"),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    },
    ({ script, enableQE, timeoutSeconds }) =>
      run("executeScript", [(enableQE ? "app.enableQE();\n" : "") + script], (timeoutSeconds ?? 60) * 1000)
  );
}
