import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../bridge.js";

const nodeId = z.string().describe("Project item nodeId (from get_project_items / find_project_items)");
const binPath = z.string().describe("Bin path like 'Footage/Interviews' ('' = project root)");

export function registerProjectTools(server: McpServer) {
  server.tool("get_project_info", "Name, path and contents summary of the active project, plus all open projects", {}, () =>
    run("getProjectInfo")
  );

  server.tool("save_project", "Save the active project", {}, () => run("saveProject"));

  server.tool(
    "save_project_as",
    "Save the active project to a new .prproj path",
    { path: z.string().describe("Absolute path of the new .prproj file") },
    ({ path }) => run("saveProjectAs", [path])
  );

  server.tool(
    "open_project",
    "Open a .prproj file (it becomes the active project)",
    { path: z.string().describe("Absolute path to the .prproj file") },
    ({ path }) => run("openProject", [path], 120_000)
  );

  server.tool(
    "new_project",
    "Create and open a new empty project",
    { path: z.string().describe("Absolute path for the new .prproj file") },
    ({ path }) => run("newProject", [path])
  );

  server.tool(
    "close_project",
    "Close the active project",
    { save: z.boolean().optional().describe("Save before closing (default true)") },
    ({ save }) => run("closeProject", [save !== false])
  );

  server.tool(
    "import_media",
    "Import media files (video, audio, images, .psd, .aep, .prproj...) into the project. Returns the nodeId of each imported item.",
    {
      filePaths: z.array(z.string()).min(1).describe("Absolute file paths"),
      targetBinPath: binPath.optional(),
      importAsNumberedStills: z.boolean().optional().describe("Treat a numbered image sequence as one clip"),
    },
    ({ filePaths, targetBinPath, importAsNumberedStills }) =>
      run("importMedia", [filePaths, targetBinPath ?? "", importAsNumberedStills ?? false], 300_000)
  );

  server.tool(
    "get_project_items",
    "List items (clips, sequences, bins) in a bin of the project panel",
    {
      binPath: binPath.optional(),
      recursive: z.boolean().optional().describe("Include items inside sub-bins (default false)"),
    },
    ({ binPath, recursive }) => run("getProjectItems", [binPath ?? "", recursive ?? false])
  );

  server.tool(
    "find_project_items",
    "Search project items by name (case-insensitive substring) across all bins",
    {
      query: z.string(),
      type: z.enum(["all", "clip", "file", "bin", "sequence"]).optional().describe("Filter by type (default all)"),
    },
    ({ query, type }) => run("findProjectItems", [query, type ?? "all"])
  );

  server.tool(
    "get_project_item_info",
    "Details of a project item: media path, duration, frame rate, video/audio info, in/out, label, proxy",
    { nodeId },
    ({ nodeId }) => run("getProjectItemInfo", [nodeId])
  );

  server.tool(
    "create_bin",
    "Create a bin (folder) in the project panel",
    { name: z.string(), parentBinPath: binPath.optional() },
    ({ name, parentBinPath }) => run("createBin", [name, parentBinPath ?? ""])
  );

  server.tool(
    "rename_project_item",
    "Rename a project item or bin",
    { nodeId, newName: z.string() },
    ({ nodeId, newName }) => run("renameProjectItem", [nodeId, newName])
  );

  server.tool(
    "move_project_item",
    "Move a project item or bin into another bin",
    { nodeId, targetBinPath: binPath },
    ({ nodeId, targetBinPath }) => run("moveProjectItem", [nodeId, targetBinPath])
  );

  server.tool(
    "delete_project_items",
    "Delete items, sequences or bins from the project (clips using them are removed from timelines)",
    { nodeIds: z.array(z.string()).min(1) },
    ({ nodeIds }) => run("deleteProjectItems", [nodeIds])
  );

  server.tool(
    "set_project_item_in_out",
    "Set source in/out points on a project item (used by the next insert/overwrite)",
    { nodeId, inPoint: z.number().optional().describe("In point, seconds"), outPoint: z.number().optional().describe("Out point, seconds") },
    ({ nodeId, inPoint, outPoint }) => run("setProjectItemInOut", [nodeId, inPoint ?? -1, outPoint ?? -1])
  );

  server.tool(
    "clear_project_item_in_out",
    "Clear source in/out points on a project item",
    { nodeId },
    ({ nodeId }) => run("clearProjectItemInOut", [nodeId])
  );

  server.tool(
    "create_subclip",
    "Create a subclip from part of a project item",
    {
      nodeId,
      name: z.string(),
      inPoint: z.number().describe("Seconds"),
      outPoint: z.number().describe("Seconds"),
      hardBoundaries: z.boolean().optional().describe("Restrict trimming to the subclip range (default true)"),
    },
    ({ nodeId, name, inPoint, outPoint, hardBoundaries }) =>
      run("createSubClip", [nodeId, name, inPoint, outPoint, hardBoundaries !== false])
  );

  server.tool(
    "relink_media",
    "Point a project item at a different media file",
    { nodeId, newPath: z.string().describe("Absolute path of the new media file") },
    ({ nodeId, newPath }) => run("relinkMedia", [nodeId, newPath])
  );

  server.tool("refresh_media", "Reload a project item's media from disk", { nodeId }, ({ nodeId }) =>
    run("refreshMedia", [nodeId])
  );

  server.tool(
    "attach_proxy",
    "Attach an existing proxy file to a project item",
    { nodeId, proxyPath: z.string() },
    ({ nodeId, proxyPath }) => run("attachProxy", [nodeId, proxyPath])
  );

  server.tool(
    "create_proxy",
    "Queue proxy creation for a project item in Media Encoder using an ingest/proxy preset (.epr)",
    { nodeId, presetPath: z.string().describe("Proxy preset .epr (see get_export_presets with filter 'proxy')") },
    ({ nodeId, presetPath }) => run("createProxy", [nodeId, presetPath])
  );

  server.tool(
    "toggle_proxies",
    "Turn proxy playback on or off",
    { enable: z.boolean() },
    ({ enable }) => run("toggleProxyMode", [enable])
  );

  server.tool(
    "set_project_item_label",
    "Set the label color of a project item",
    {
      nodeId,
      color: z
        .union([z.number().int().min(0).max(15), z.string()])
        .describe("violet, iris, caribbean, lavender, cerulean, forest, rose, mango, purple, blue, teal, magenta, tan, green, brown, yellow (or 0-15)"),
    },
    ({ nodeId, color }) => run("setProjectItemLabel", [nodeId, color])
  );

  server.tool(
    "set_scale_to_frame_size",
    "Turn on 'Scale to Frame Size' for a project item",
    { nodeId },
    ({ nodeId }) => run("setScaleToFrameSize", [nodeId])
  );

  server.tool(
    "set_override_frame_rate",
    "Interpret footage at a different frame rate",
    { nodeId, frameRate: z.number().positive() },
    ({ nodeId, frameRate }) => run("setOverrideFrameRate", [nodeId, frameRate])
  );

  server.tool(
    "set_override_pixel_aspect_ratio",
    "Interpret footage with a different pixel aspect ratio",
    { nodeId, numerator: z.number().int().positive(), denominator: z.number().int().positive() },
    ({ nodeId, numerator, denominator }) => run("setOverridePixelAspectRatio", [nodeId, numerator, denominator])
  );

  server.tool("consolidate_duplicates", "Merge duplicate media items in the project", {}, () =>
    run("consolidateDuplicates")
  );

  server.tool(
    "import_ae_comps",
    "Import compositions from an After Effects project (Dynamic Link)",
    {
      aepPath: z.string(),
      compNames: z.array(z.string()).optional().describe("Compositions to import (omit for all)"),
      targetBinPath: binPath.optional(),
    },
    ({ aepPath, compNames, targetBinPath }) => run("importAEComps", [aepPath, compNames ?? [], targetBinPath ?? ""], 300_000)
  );

  server.tool(
    "import_sequences",
    "Import sequences from another Premiere project",
    {
      projectPath: z.string(),
      sequenceIds: z.array(z.string()).optional().describe("Sequence IDs to import (omit to import the whole project)"),
    },
    ({ projectPath, sequenceIds }) => run("importSequences", [projectPath, sequenceIds ?? []], 300_000)
  );

  server.tool(
    "set_scratch_disks",
    "Point the project's capture, preview and auto-save folders at a path",
    { path: z.string() },
    ({ path }) => run("setScratchDisks", [path])
  );

  server.tool(
    "select_project_items",
    "Select items in the Project panel",
    { nodeIds: z.array(z.string()).min(1) },
    ({ nodeIds }) => run("selectProjectItems", [nodeIds])
  );

  server.tool("get_project_panel_selection", "Items currently selected in the Project panel", {}, () =>
    run("getProjectPanelSelection")
  );
}
