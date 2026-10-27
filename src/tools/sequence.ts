import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../bridge.js";
import { trackType, trackIndex } from "./common.js";

const seqRef = z.string().describe("Sequence name or ID (from get_sequences)");

export function registerSequenceTools(server: McpServer) {
  server.tool("get_sequences", "List all sequences with size, frame rate, duration and track counts", {}, () =>
    run("getSequences")
  );

  server.tool(
    "get_active_sequence",
    "Overview of the sequence open in the timeline: settings, playhead, in/out, every track (clips, muted, locked, targeted)",
    {},
    () => run("getActiveSequence")
  );

  server.tool("set_active_sequence", "Open a sequence in the timeline", { sequence: seqRef }, ({ sequence }) =>
    run("setActiveSequence", [sequence])
  );

  server.tool(
    "create_sequence",
    "Create a sequence and open it. Defaults to 1920x1080 25 fps; set width/height/fps for other formats (e.g. 1080x1920 for vertical).",
    {
      name: z.string(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      fps: z.number().positive().optional().describe("Frame rate, e.g. 23.976, 24, 25, 29.97, 30, 50, 60"),
      presetPath: z.string().optional().describe("Optional .sqpreset file to start from"),
    },
    ({ name, width, height, fps, presetPath }) => run("createSequence", [name, width, height, fps, presetPath])
  );

  server.tool(
    "create_sequence_from_clips",
    "Create a sequence matching the clips' settings, with the clips placed in order",
    {
      name: z.string().optional(),
      nodeIds: z.array(z.string()).min(1).describe("Project item nodeIds in the order to place them"),
      binPath: z.string().optional().describe("Bin for the new sequence"),
    },
    ({ name, nodeIds, binPath }) => run("createSequenceFromClips", [name, nodeIds, binPath ?? ""])
  );

  server.tool(
    "clone_sequence",
    "Duplicate a sequence",
    { sequence: seqRef.optional().describe("Sequence to copy (default: active)"), newName: z.string().optional() },
    ({ sequence, newName }) => run("cloneSequence", [sequence, newName])
  );

  server.tool(
    "create_checkpoint",
    "Save a copy of the active sequence in the 'prmcp checkpoints' bin before a multi-step edit. Premiere has no grouped undo for scripted edits; restore_checkpoint reverts everything since the checkpoint in one step.",
    { label: z.string().optional().describe("Short note, e.g. 'remove intro'") },
    ({ label }) => run("createCheckpoint", [label])
  );

  server.tool(
    "restore_checkpoint",
    "Put a checkpoint back in place of the sequence it was copied from (takes its name and bin, opens it). The edited version is kept, renamed, in the checkpoints bin.",
    {
      checkpoint: seqRef.describe("Checkpoint sequence name or ID"),
      target: seqRef.optional().describe("Sequence to replace (default: active)"),
    },
    ({ checkpoint, target }) => run("restoreCheckpoint", [checkpoint, target])
  );

  server.tool("rename_sequence", "Rename a sequence", { sequence: seqRef, newName: z.string() }, ({ sequence, newName }) =>
    run("renameSequence", [sequence, newName])
  );

  server.tool("delete_sequence", "Delete a sequence from the project", { sequence: seqRef }, ({ sequence }) =>
    run("deleteSequence", [sequence])
  );

  server.tool(
    "close_sequence",
    "Close a sequence's timeline tab",
    { sequence: seqRef.optional().describe("Default: active") },
    ({ sequence }) => run("closeSequence", [sequence])
  );

  server.tool("get_sequence_settings", "Frame size, fps, pixel aspect, audio and render settings of the active sequence", {}, () =>
    run("getSequenceSettings")
  );

  server.tool(
    "set_sequence_settings",
    "Change frame size, frame rate or render quality of the active sequence",
    {
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      fps: z.number().positive().optional(),
      maximumBitDepth: z.boolean().optional(),
      maximumRenderQuality: z.boolean().optional(),
    },
    ({ width, height, fps, maximumBitDepth, maximumRenderQuality }) =>
      run("setSequenceSettings", [width, height, fps, maximumBitDepth, maximumRenderQuality])
  );

  server.tool(
    "set_sequence_in_out",
    "Set the active sequence's in and/or out point (used by export with range 'inOut')",
    { inPoint: z.number().min(0).optional().describe("Seconds"), outPoint: z.number().min(0).optional().describe("Seconds") },
    ({ inPoint, outPoint }) => run("setSequenceInOut", [inPoint ?? -1, outPoint ?? -1])
  );

  server.tool("clear_sequence_in_out", "Reset in/out to the whole sequence", {}, () => run("clearSequenceInOut"));

  server.tool(
    "add_tracks",
    "Add video and/or audio tracks at the top/bottom of the active sequence",
    {
      videoTracks: z.number().int().min(0).optional(),
      audioTracks: z.number().int().min(0).optional(),
      audioType: z.enum(["mono", "stereo", "5.1", "adaptive"]).optional().describe("Default stereo"),
    },
    ({ videoTracks, audioTracks, audioType }) => run("addTracks", [videoTracks ?? 0, audioTracks ?? 0, audioType ?? "stereo"])
  );

  server.tool("remove_track", "Delete an empty track", { trackType, trackIndex }, ({ trackType, trackIndex }) =>
    run("removeTrack", [trackType, trackIndex])
  );

  server.tool("remove_empty_tracks", "Delete all empty video and audio tracks", {}, () => run("removeEmptyTracks"));

  server.tool(
    "get_track_info",
    "A track's state and every clip on it",
    { trackType, trackIndex },
    ({ trackType, trackIndex }) => run("getTrackInfo", [trackType, trackIndex])
  );

  server.tool(
    "set_track_muted",
    "Mute/unmute a track (video tracks: toggle output)",
    { trackType, trackIndex, muted: z.boolean() },
    ({ trackType, trackIndex, muted }) => run("setTrackMuted", [trackType, trackIndex, muted])
  );

  server.tool(
    "set_track_locked",
    "Lock/unlock a track",
    { trackType, trackIndex, locked: z.boolean() },
    ({ trackType, trackIndex, locked }) => run("setTrackLocked", [trackType, trackIndex, locked])
  );

  server.tool(
    "set_track_targeted",
    "Set track targeting (which tracks paste/match-frame/subsequence use)",
    { trackType, trackIndex, targeted: z.boolean() },
    ({ trackType, trackIndex, targeted }) => run("setTrackTargeted", [trackType, trackIndex, targeted])
  );

  server.tool(
    "rename_track",
    "Rename a track",
    { trackType, trackIndex, name: z.string() },
    ({ trackType, trackIndex, name }) => run("renameTrack", [trackType, trackIndex, name])
  );

  server.tool(
    "auto_reframe_sequence",
    "Create an auto-reframed copy of the active sequence for another aspect ratio (Adobe Sensei)",
    {
      numerator: z.number().int().positive().describe("e.g. 9 for 9:16"),
      denominator: z.number().int().positive().describe("e.g. 16 for 9:16"),
      motionPreset: z.enum(["slower", "default", "faster"]).optional(),
      newName: z.string().optional(),
      useNestedSequences: z.boolean().optional(),
    },
    ({ numerator, denominator, motionPreset, newName, useNestedSequences }) =>
      run("autoReframeSequence", [numerator, denominator, motionPreset ?? "default", newName, useNestedSequences ?? false], 600_000)
  );

  server.tool(
    "scene_edit_detection",
    "Detect cuts inside the selected clips (select them first with select_clips) and cut them, add markers or make subclips",
    {
      action: z.enum(["ApplyCuts", "CreateMarkers"]).describe("What to do at each detected cut"),
      applyCutsToLinkedAudio: z.boolean().optional(),
      sensitivity: z.enum(["LowSensitivity", "MediumSensitivity", "HighSensitivity"]).optional(),
    },
    ({ action, applyCutsToLinkedAudio, sensitivity }) =>
      run("sceneEditDetection", [action, applyCutsToLinkedAudio !== false, sensitivity ?? "MediumSensitivity"], 600_000)
  );

  server.tool(
    "create_subsequence",
    "Make a new sequence from the active sequence's in/out range",
    { ignoreTrackTargeting: z.boolean().optional().describe("Include all tracks, not only targeted ones") },
    ({ ignoreTrackTargeting }) => run("createSubsequence", [ignoreTrackTargeting ?? false])
  );
}
