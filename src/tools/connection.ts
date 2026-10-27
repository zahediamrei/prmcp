import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isConnected, getPort, callPremiere, toolResult } from "../bridge.js";

export function registerConnectionTools(server: McpServer) {
  server.tool(
    "get_status",
    "Check the connection to Premiere Pro and get the app version, active project and active sequence. Call this first.",
    {},
    async () => {
      if (!isConnected()) {
        return toolResult({
          connected: false,
          port: getPort(),
          help: "Open Premiere Pro, then Window > Extensions > Premiere Connector. The panel connects automatically.",
        });
      }
      const app = await callPremiere("getAppVersion");
      let project = null;
      try {
        project = await callPremiere("getProjectInfo");
      } catch (e: any) {
        project = { error: e.message };
      }
      return toolResult({ connected: true, premiere: app, project });
    }
  );
}
