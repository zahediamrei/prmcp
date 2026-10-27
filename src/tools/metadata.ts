import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../bridge.js";

const nodeId = z.string().describe("Project item nodeId");

export function registerMetadataTools(server: McpServer) {
  server.tool("get_project_columns", "Project panel metadata columns of an item (codec, duration, description, log note...)", { nodeId }, ({ nodeId }) =>
    run("getProjectColumns", [nodeId])
  );

  server.tool(
    "set_project_column",
    "Write a Project panel column: Description, Comment, Log Note, Scene, Shot, Good",
    { nodeId, column: z.string(), value: z.string() },
    ({ nodeId, column, value }) => run("setProjectColumn", [nodeId, column, value])
  );

  server.tool("get_xmp_metadata", "Raw XMP metadata of a project item", { nodeId }, ({ nodeId }) => run("getXMPMetadata", [nodeId]));

  server.tool(
    "set_xmp_metadata",
    "Replace the XMP metadata of a project item (pass a full XMP packet, e.g. edited from get_xmp_metadata)",
    { nodeId, xmp: z.string() },
    ({ nodeId, xmp }) => run("setXMPMetadata", [nodeId, xmp])
  );
}
