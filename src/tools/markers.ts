import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../bridge.js";
import { clip } from "./common.js";

const color = z.enum(["green", "red", "purple", "orange", "yellow", "white", "blue", "cyan"]);
const markerType = z.enum(["comment", "chapter", "segmentation", "weblink"]);
const markerIndex = z.number().int().min(0).describe("Marker index from get_markers");

export function registerMarkerTools(server: McpServer) {
  server.tool(
    "add_marker",
    "Add a marker to the active sequence",
    {
      time: z.number().min(0).describe("Seconds"),
      name: z.string().optional(),
      comment: z.string().optional(),
      color: color.optional(),
      duration: z.number().min(0).optional().describe("Seconds (0 = point marker)"),
      type: markerType.optional(),
      url: z.string().optional().describe("For weblink markers"),
    },
    (a) => run("addMarker", [a.time, a.name, a.comment, a.color, a.duration ?? 0, a.type, a.url])
  );

  server.tool(
    "add_markers",
    "Add many sequence markers at once (e.g. chapters or beat markers)",
    {
      markers: z
        .array(
          z.object({
            time: z.number().min(0),
            name: z.string().optional(),
            comment: z.string().optional(),
            color: color.optional(),
            duration: z.number().min(0).optional(),
            type: markerType.optional(),
          })
        )
        .min(1),
    },
    ({ markers }) => run("addMarkers", [markers])
  );

  server.tool("get_markers", "All markers on the active sequence", {}, () => run("getMarkers"));

  server.tool(
    "update_marker",
    "Change a sequence marker",
    {
      index: markerIndex,
      name: z.string().optional(),
      comment: z.string().optional(),
      color: color.optional(),
      duration: z.number().min(0).optional(),
      start: z.number().min(0).optional().describe("Move it to this time (seconds)"),
    },
    (a) => run("updateMarker", [a.index, a.name, a.comment, a.color, a.duration ?? -1, a.start ?? -1])
  );

  server.tool("remove_marker", "Delete a sequence marker", { index: markerIndex }, ({ index }) => run("removeMarker", [index]));

  server.tool("clear_markers", "Delete all markers on the active sequence", {}, () => run("clearAllMarkers"));

  server.tool(
    "add_clip_marker",
    "Add a marker to a clip's source media at a sequence time inside the clip",
    { ...clip, time: z.number().min(0).describe("Sequence time, seconds"), name: z.string().optional(), comment: z.string().optional(), color: color.optional() },
    (a) => run("addClipMarker", [a.trackType, a.trackIndex, a.clipIndex, a.time, a.name, a.comment, a.color])
  );

  server.tool("get_clip_markers", "Markers within a clip (sequence times)", clip, (a) =>
    run("getClipMarkers", [a.trackType, a.trackIndex, a.clipIndex])
  );

  server.tool(
    "add_project_item_marker",
    "Add a marker to a project item's media (source time)",
    {
      nodeId: z.string(),
      time: z.number().min(0).describe("Source time, seconds"),
      name: z.string().optional(),
      comment: z.string().optional(),
      color: color.optional(),
      duration: z.number().min(0).optional(),
    },
    (a) => run("addProjectItemMarker", [a.nodeId, a.time, a.name, a.comment, a.color, a.duration ?? 0])
  );

  server.tool("get_project_item_markers", "Markers on a project item's media", { nodeId: z.string() }, ({ nodeId }) =>
    run("getProjectItemMarkers", [nodeId])
  );
}
