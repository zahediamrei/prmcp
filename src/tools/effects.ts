import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../bridge.js";
import { clip, effectRef, propertyRef, trackType, trackIndex } from "./common.js";

const keyRef = z
  .union([
    z.object({ index: z.number().int().min(0) }),
    z.object({ time: z.number().describe("Sequence time of the keyframe, seconds") }),
  ])
  .describe("Which keyframe: {index} or {time}");

const value = z
  .union([z.number(), z.string(), z.boolean(), z.array(z.number())])
  .describe("New value. Position/Anchor Point are [x, y] in 0-1 frame units (or use set_clip_transform for pixels).");

const interpolation = z.enum(["linear", "hold", "bezier", "ease"]);

export function registerEffectsTools(server: McpServer) {
  server.tool(
    "get_effects_list",
    "Names of available effects or transitions (use a filter, the full lists are long)",
    {
      kind: z.enum(["video", "audio", "videoTransitions", "audioTransitions"]),
      filter: z.string().optional().describe("Case-insensitive substring, e.g. 'blur', 'lumetri', 'dissolve'"),
    },
    ({ kind, filter }) => run("getEffectsList", [kind, filter ?? ""])
  );

  server.tool(
    "apply_effect",
    "Add an effect to a clip (video effect on video clips, audio effect on audio clips)",
    { ...clip, effectName: z.string().describe("Exact or unambiguous partial name from get_effects_list") },
    (a) => run("applyEffect", [a.trackType, a.trackIndex, a.clipIndex, a.effectName])
  );

  server.tool("remove_effect", "Remove an added effect from a clip", { ...clip, effect: effectRef }, (a) =>
    run("removeEffect", [a.trackType, a.trackIndex, a.clipIndex, a.effect])
  );

  server.tool(
    "get_clip_effects",
    "Every effect on a clip (incl. Motion, Opacity, Volume) with property names, values and keyframes",
    clip,
    (a) => run("getClipEffects", [a.trackType, a.trackIndex, a.clipIndex])
  );

  server.tool(
    "get_effect_property",
    "Read one effect property",
    { ...clip, effect: effectRef, property: propertyRef },
    (a) => run("getEffectProperty", [a.trackType, a.trackIndex, a.clipIndex, a.effect, a.property])
  );

  server.tool(
    "set_effect_property",
    "Set an effect property. If the property is animated (or time is given) a keyframe is set instead.",
    { ...clip, effect: effectRef, property: propertyRef, value, time: z.number().optional().describe("Keyframe at this sequence time (seconds)") },
    (a) => run("setEffectProperty", [a.trackType, a.trackIndex, a.clipIndex, a.effect, a.property, a.value, a.time ?? -1])
  );

  server.tool(
    "add_keyframe",
    "Add/update a keyframe. Time is the sequence time in seconds (must be inside the clip).",
    { ...clip, effect: effectRef, property: propertyRef, time: z.number().min(0), value, interpolation: interpolation.optional() },
    (a) => run("addKeyframe", [a.trackType, a.trackIndex, a.clipIndex, a.effect, a.property, a.time, a.value, a.interpolation])
  );

  server.tool(
    "get_keyframes",
    "Keyframes of a property (times in sequence seconds)",
    { ...clip, effect: effectRef, property: propertyRef },
    (a) => run("getKeyframes", [a.trackType, a.trackIndex, a.clipIndex, a.effect, a.property])
  );

  server.tool(
    "remove_keyframe",
    "Delete one keyframe",
    { ...clip, effect: effectRef, property: propertyRef, keyframe: keyRef },
    (a) => run("removeKeyframe", [a.trackType, a.trackIndex, a.clipIndex, a.effect, a.property, a.keyframe])
  );

  server.tool(
    "clear_keyframes",
    "Remove all keyframes from a property (turns animation off)",
    { ...clip, effect: effectRef, property: propertyRef },
    (a) => run("clearKeyframes", [a.trackType, a.trackIndex, a.clipIndex, a.effect, a.property])
  );

  server.tool(
    "set_keyframe_interpolation",
    "Set keyframe interpolation (linear, hold, bezier/ease) for one keyframe or all",
    { ...clip, effect: effectRef, property: propertyRef, keyframe: z.union([keyRef, z.literal("all")]), interpolation },
    (a) => run("setKeyframeInterpolation", [a.trackType, a.trackIndex, a.clipIndex, a.effect, a.property, a.keyframe, a.interpolation])
  );

  server.tool(
    "get_clip_transform",
    "Motion/Opacity of a video clip in pixels: x, y, scale, rotation, anchor, crop, opacity",
    { trackIndex, clipIndex: clip.clipIndex },
    (a) => run("getClipTransform", [a.trackIndex, a.clipIndex])
  );

  server.tool(
    "set_clip_transform",
    "Position/scale/rotate/crop/fade a video clip. x,y are pixels of the frame center point (frame center = width/2, height/2). Give time to keyframe the change (e.g. for a zoom or move).",
    {
      trackIndex,
      clipIndex: clip.clipIndex,
      x: z.number().optional(),
      y: z.number().optional(),
      scale: z.number().optional().describe("Percent, 100 = original"),
      scaleWidth: z.number().optional().describe("Percent; turns off uniform scale"),
      uniformScale: z.boolean().optional(),
      rotation: z.number().optional().describe("Degrees"),
      anchorX: z.number().optional(),
      anchorY: z.number().optional(),
      opacity: z.number().min(0).max(100).optional(),
      blendMode: z.string().optional().describe("normal, multiply, screen, overlay, soft light, add, ..."),
      cropLeft: z.number().min(0).max(100).optional(),
      cropTop: z.number().min(0).max(100).optional(),
      cropRight: z.number().min(0).max(100).optional(),
      cropBottom: z.number().min(0).max(100).optional(),
      time: z.number().optional().describe("Set as keyframes at this sequence time (seconds)"),
    },
    ({ trackIndex, clipIndex, ...t }) => run("setClipTransform", [trackIndex, clipIndex, t])
  );

  server.tool(
    "get_transitions",
    "Transitions on the active sequence's tracks",
    { trackType: trackType.optional(), trackIndex: trackIndex.optional() },
    ({ trackType, trackIndex }) => run("getTransitions", [trackType, trackIndex ?? -1])
  );

  server.tool(
    "apply_transition",
    "Add a transition at a clip's start, end or both (default Cross Dissolve / Constant Power, 1 s, centered on the cut). Length is limited by available handles.",
    {
      ...clip,
      transitionName: z.string().optional().describe("From get_effects_list kind videoTransitions/audioTransitions"),
      duration: z.number().positive().optional().describe("Seconds (default 1)"),
      position: z.enum(["start", "end", "both"]).optional().describe("Default end"),
      alignment: z.enum(["center", "start", "end"]).optional().describe("center = across the cut; start = begins at the cut; end = ends at the cut"),
    },
    (a) => run("applyTransition", [a.trackType, a.trackIndex, a.clipIndex, a.transitionName, a.duration, a.position ?? "end", a.alignment ?? "center"])
  );

  server.tool(
    "remove_transition",
    "Remove a transition (index from get_transitions for that track)",
    { trackType, trackIndex, transitionIndex: z.number().int().min(0) },
    (a) => run("removeTransition", [a.trackType, a.trackIndex, a.transitionIndex])
  );
}
