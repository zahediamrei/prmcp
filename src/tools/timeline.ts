import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../bridge.js";
import { clip, clipRef, trackType, trackIndex } from "./common.js";

const placement = {
  nodeId: z.string().describe("Project item nodeId of the media to place"),
  trackType: trackType.optional().describe("Track type to place on (default video; video clips bring their audio along)"),
  trackIndex: trackIndex.optional().describe("Default 0"),
  sourceIn: z.number().min(0).optional().describe("Use the media from this source time (seconds)"),
  sourceOut: z.number().min(0).optional().describe("...up to this source time (seconds)"),
};

export function registerTimelineTools(server: McpServer) {
  server.tool(
    "get_timeline_clips",
    "List clips in the active sequence with timeline start/end, duration, source in/out (seconds), speed and state. Clip indexes change after edits, so re-read after cutting or moving.",
    {
      trackType: z.enum(["video", "audio", "all"]).optional(),
      trackIndex: trackIndex.optional().describe("Only this track"),
    },
    ({ trackType, trackIndex }) => run("getTimelineClips", [trackType ?? "all", trackIndex ?? -1])
  );

  server.tool("get_clip_info", "Full details of one clip: timing, linked clips, applied effects", clip, (a) =>
    run("getClipInfo", [a.trackType, a.trackIndex, a.clipIndex])
  );

  server.tool("find_clips", "Find timeline clips whose name contains text", { query: z.string() }, ({ query }) =>
    run("findClips", [query])
  );

  server.tool(
    "get_clips_at_time",
    "Clips under a given time on every track",
    { time: z.number().min(0).describe("Seconds") },
    ({ time }) => run("getClipsAtTime", [time])
  );

  server.tool(
    "insert_clip",
    "Insert edit: place media at a time and push everything after it later",
    { ...placement, time: z.number().min(0).describe("Timeline time in seconds") },
    (a) => run("insertClip", [a.nodeId, a.trackType ?? "video", a.trackIndex ?? 0, a.time, a.sourceIn, a.sourceOut])
  );

  server.tool(
    "overwrite_clip",
    "Overwrite edit: place media at a time, replacing whatever is there",
    { ...placement, time: z.number().min(0).describe("Timeline time in seconds") },
    (a) => run("overwriteClip", [a.nodeId, a.trackType ?? "video", a.trackIndex ?? 0, a.time, a.sourceIn, a.sourceOut])
  );

  server.tool("append_clip", "Place media right after the last clip on a track", placement, (a) =>
    run("appendClip", [a.nodeId, a.trackType ?? "video", a.trackIndex ?? 0, a.sourceIn, a.sourceOut])
  );

  server.tool(
    "remove_clip",
    "Delete a clip (and its linked audio/video by default). ripple=true closes the gap.",
    {
      ...clip,
      ripple: z.boolean().optional().describe("Close the gap (default false)"),
      includeLinked: z.boolean().optional().describe("Also remove linked audio/video (default true)"),
    },
    (a) => run("removeClip", [a.trackType, a.trackIndex, a.clipIndex, a.ripple ?? false, a.includeLinked !== false])
  );

  server.tool(
    "move_clip",
    "Move a clip (with its linked clips) to a new start time on the same track",
    { ...clip, newStart: z.number().min(0).describe("Seconds"), includeLinked: z.boolean().optional() },
    (a) => run("moveClip", [a.trackType, a.trackIndex, a.clipIndex, a.newStart, a.includeLinked !== false])
  );

  server.tool(
    "move_clip_to_track",
    "Move a clip to another track of the same type, keeping its time",
    { ...clip, targetTrackIndex: trackIndex },
    (a) => run("moveClipToTrack", [a.trackType, a.trackIndex, a.clipIndex, a.targetTrackIndex])
  );

  server.tool(
    "trim_clip",
    "Trim a clip's edges on the timeline: newStart trims/extends the head, newEnd the tail (source media follows). Linked clips are trimmed too. Leaves gaps; use close_gaps or ripple_delete_range to close them.",
    {
      ...clip,
      newStart: z.number().min(0).optional().describe("New timeline start, seconds"),
      newEnd: z.number().min(0).optional().describe("New timeline end, seconds"),
      includeLinked: z.boolean().optional(),
    },
    (a) => run("trimClip", [a.trackType, a.trackIndex, a.clipIndex, a.newStart ?? -1, a.newEnd ?? -1, a.includeLinked !== false])
  );

  server.tool(
    "razor_clip",
    "Cut the clip on one track at a time",
    { trackType, trackIndex, time: z.number().min(0).describe("Seconds") },
    (a) => run("razorClip", [a.trackType, a.trackIndex, a.time])
  );

  server.tool(
    "razor_all_tracks",
    "Cut every unlocked track at a time (like Add Edit to All Tracks)",
    { time: z.number().min(0).describe("Seconds") },
    ({ time }) => run("razorAllTracks", [time])
  );

  server.tool(
    "ripple_delete_range",
    "Remove a time range from every unlocked track and close the gap (great for cutting out mistakes, silences or a section). Premiere records this as many undo steps, so a checkpoint copy of the sequence is taken first: restore_checkpoint reverts the whole edit at once, and a failed edit is rolled back automatically.",
    {
      start: z.number().min(0).describe("Seconds"),
      end: z.number().min(0).describe("Seconds"),
      checkpoint: z.boolean().optional().describe("Copy the sequence first so the edit can be reverted in one step (default true)"),
    },
    ({ start, end, checkpoint }) => run("rippleDeleteRange", [start, end, checkpoint !== false])
  );

  server.tool(
    "close_gaps",
    "Remove empty space between clips by sliding clips left",
    {
      trackType: z.enum(["video", "audio", "all"]).optional(),
      trackIndex: trackIndex.optional().describe("Only this track (default all tracks)"),
    },
    ({ trackType, trackIndex }) => run("closeGaps", [trackType ?? "all", trackIndex ?? -1])
  );

  server.tool(
    "set_clip_speed",
    "Change clip speed (1 = normal, 2 = 200%, 0.5 = 50%). Linked audio follows. With ripple, later clips move to make room / close up.",
    {
      ...clip,
      speed: z.number().positive(),
      reverse: z.boolean().optional(),
      ripple: z.boolean().optional().describe("Shift later clips (default false: clip is shortened to fit if slowing down)"),
      maintainPitch: z.boolean().optional().describe("Keep audio pitch (default true)"),
    },
    (a) => run("setClipSpeed", [a.trackType, a.trackIndex, a.clipIndex, a.speed, a.reverse ?? false, a.ripple ?? false, a.maintainPitch !== false])
  );

  server.tool(
    "set_clip_enabled",
    "Enable or disable a clip",
    { ...clip, enabled: z.boolean() },
    (a) => run("setClipEnabled", [a.trackType, a.trackIndex, a.clipIndex, a.enabled])
  );

  server.tool("rename_clip", "Rename a clip instance on the timeline", { ...clip, newName: z.string() }, (a) =>
    run("renameClip", [a.trackType, a.trackIndex, a.clipIndex, a.newName])
  );

  server.tool(
    "link_clips",
    "Link clips together (e.g. a video clip and an audio clip)",
    { clips: z.array(clipRef).min(2) },
    ({ clips }) => run("linkClips", [clips])
  );

  server.tool("unlink_clip", "Unlink a clip from its linked audio/video", clip, (a) =>
    run("unlinkClip", [a.trackType, a.trackIndex, a.clipIndex])
  );

  server.tool(
    "slip_clip",
    "Slip: show a different part of the source without moving or resizing the clip (positive = later in the source)",
    { ...clip, offset: z.number().describe("Seconds") },
    (a) => run("slipClip", [a.trackType, a.trackIndex, a.clipIndex, a.offset])
  );

  server.tool(
    "slide_clip",
    "Slide: move a clip left/right while its neighbours are trimmed to compensate",
    { ...clip, offset: z.number().describe("Seconds (negative = earlier)") },
    (a) => run("slideClip", [a.trackType, a.trackIndex, a.clipIndex, a.offset])
  );

  server.tool(
    "duplicate_clip",
    "Copy a clip (same source range) to a time and track (overwrite)",
    { ...clip, time: z.number().min(0).describe("Seconds"), targetTrackIndex: trackIndex.optional() },
    (a) => run("duplicateClip", [a.trackType, a.trackIndex, a.clipIndex, a.time, a.targetTrackIndex ?? -1])
  );

  server.tool("get_selection", "Clips selected in the timeline", {}, () => run("getSelection"));

  server.tool(
    "select_clips",
    "Select clips in the timeline",
    { clips: z.array(clipRef).min(1), addToSelection: z.boolean().optional() },
    ({ clips, addToSelection }) => run("selectClips", [clips, addToSelection ?? false])
  );

  server.tool("deselect_all", "Clear the timeline selection", {}, () => run("deselectAll"));
}
