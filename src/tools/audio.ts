import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../bridge.js";
import { trackIndex, clipIndex } from "./common.js";

const audioClip = { trackIndex: trackIndex.describe("Audio track index, 0-based (A1 = 0)"), clipIndex };

export function registerAudioTools(server: McpServer) {
  server.tool(
    "get_clip_volume",
    "Volume of an audio clip in dB (plus keyframes and L/R channel levels if present)",
    audioClip,
    (a) => run("getClipVolume", [a.trackIndex, a.clipIndex])
  );

  server.tool(
    "set_clip_volume",
    "Set an audio clip's volume in dB (0 = unchanged, -6 = half as loud, +6 louder; max +15). Give time to set a keyframe instead.",
    { ...audioClip, volumeDb: z.number().max(15), time: z.number().optional().describe("Keyframe at this sequence time (seconds)") },
    (a) => run("setClipVolume", [a.trackIndex, a.clipIndex, a.volumeDb, a.time ?? -1])
  );

  server.tool(
    "fade_clip_volume",
    "Fade an audio clip in and/or out with volume keyframes",
    {
      ...audioClip,
      fadeIn: z.number().min(0).optional().describe("Seconds"),
      fadeOut: z.number().min(0).optional().describe("Seconds"),
      volumeDb: z.number().optional().describe("Level between the fades (default: current)"),
    },
    (a) => run("fadeClipVolume", [a.trackIndex, a.clipIndex, a.fadeIn ?? 0, a.fadeOut ?? 0, a.volumeDb])
  );

  server.tool(
    "set_clip_channel_volume",
    "Left/right channel levels (dB) of a stereo clip, e.g. to balance or pan it",
    { ...audioClip, leftDb: z.number().max(15).optional(), rightDb: z.number().max(15).optional() },
    (a) => run("setClipChannelVolume", [a.trackIndex, a.clipIndex, a.leftDb, a.rightDb])
  );

  server.tool("get_track_volume", "Audio Track Mixer fader level of a track (dB)", { trackIndex }, ({ trackIndex }) =>
    run("getTrackVolume", [trackIndex])
  );

  server.tool(
    "set_track_volume",
    "Set the Audio Track Mixer fader of a track (dB, max +6)",
    { trackIndex, volumeDb: z.number().max(6) },
    ({ trackIndex, volumeDb }) => run("setTrackVolume", [trackIndex, volumeDb])
  );

  server.tool(
    "set_clip_mute",
    "Mute (disable) or unmute an audio clip",
    { ...audioClip, muted: z.boolean() },
    (a) => run("setClipMute", [a.trackIndex, a.clipIndex, a.muted])
  );
}
