// Safety layer wrapped around every tool. Premiere's scripting API gives no
// grouped undo, no change events and only positional clip indexes, so the
// server makes up for it here:
// - clipId: tools accept a stable clip ID instead of track + clip index
// - change report: each edit returns what it changed on the timeline
// - manual edits: an edit first reports changes made outside prmcp since its last call
// - checkpoint: risky edits copy the sequence first and roll back if they fail
// - dry_run: structural edits can be tried on a throwaway copy of the sequence
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPremiere } from "./bridge.js";
import { clipId as clipIdSchema } from "./tools/common.js";

type Snap = {
  sequenceId: string;
  sequenceName: string;
  tracks: { video: number; audio: number };
  clips: SnapClip[];
};
type SnapClip = {
  id: string | null;
  name: string;
  track: string;
  trackType: "video" | "audio";
  trackIndex: number;
  clipIndex: number;
  start: number;
  end: number;
  sourceIn: number;
  speed?: number;
  enabled?: boolean;
};
type Loc = { trackType: "video" | "audio"; trackIndex: number; clipIndex: number };
type Ctx = Record<string, unknown>;

// Tools that change the active sequence's timeline: their effect is reported.
const EDIT_TOOLS = new Set([
  "insert_clip", "overwrite_clip", "append_clip", "remove_clip", "move_clip", "move_clip_to_track",
  "trim_clip", "razor_clip", "razor_all_tracks", "ripple_delete_range", "close_gaps", "set_clip_speed",
  "set_clip_enabled", "rename_clip", "link_clips", "unlink_clip", "slip_clip", "slide_clip", "duplicate_clip",
  "add_tracks", "remove_track", "remove_empty_tracks", "scene_edit_detection", "create_subsequence",
  "add_text", "import_mogrt", "import_library_graphic", "place_mogrt_with_media", "replace_mogrt_media",
  "add_text_captions", "elevenlabs_voice_lines", "elevenlabs_generate_speech",
  "undo", "redo", "execute_extendscript", "restore_checkpoint",
]);

// Structural edits that can be previewed on a copy of the sequence.
const DRY_RUN_TOOLS = new Set([
  "insert_clip", "overwrite_clip", "append_clip", "remove_clip", "move_clip", "move_clip_to_track",
  "trim_clip", "razor_clip", "razor_all_tracks", "ripple_delete_range", "close_gaps", "set_clip_speed",
  "set_clip_enabled", "slip_clip", "slide_clip", "duplicate_clip", "add_tracks", "remove_track", "remove_empty_tracks",
]);

// Edits made of many undo steps, or that remove material: checkpointed by default.
const CHECKPOINT_TOOLS: Record<string, (a: Ctx) => boolean> = {
  ripple_delete_range: () => true,
  close_gaps: () => true,
  razor_all_tracks: () => true,
  remove_track: () => true,
  remove_empty_tracks: () => true,
  slide_clip: () => true,
  scene_edit_detection: (a) => a.action === "ApplyCuts",
  remove_clip: (a) => a.ripple === true,
  set_clip_speed: (a) => a.ripple === true,
};

// Reads after which the model knows the current timeline.
const TIMELINE_READS = new Set(["get_timeline_clips", "get_active_sequence"]);

// Clip-addressed tools whose clip must be on an audio track (they have no trackType).
const AUDIO_CLIP_TOOLS = new Set(["get_clip_volume", "set_clip_volume", "fade_clip_volume", "set_clip_channel_volume", "set_clip_mute"]);

const lastSeen = new Map<string, Snap>(); // sequenceId -> timeline after prmcp's last call

// Premiere runs one script at a time, and a dry run temporarily opens a copy of
// the sequence, so calls are handled one after another.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

async function snapshot(): Promise<Snap | null> {
  try {
    // With no open sequence the panel answers {success: true} rather than null.
    const s = (await callPremiere("timelineSnapshot", [])) as Snap | null;
    return s && Array.isArray(s.clips) ? s : null;
  } catch {
    return null;
  }
}

/* ---------- diffs ---------- */

function keyed(snap: Snap): Map<string, SnapClip> {
  // IDs are used when every clip has a unique one; otherwise clips are matched by
  // what doesn't change when they move: track type, name and source in point.
  const ids = snap.clips.map((c) => c.id);
  const useIds = ids.every((id) => !!id) && new Set(ids).size === ids.length;
  const m = new Map<string, SnapClip>();
  for (const c of snap.clips) {
    let k = useIds ? (c.id as string) : `${c.trackType}|${c.name}|${c.sourceIn}`;
    while (m.has(k)) k += "'";
    m.set(k, c);
  }
  return m;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const where = (c: SnapClip) => `${c.track} ${fmt(c.start)}–${fmt(c.end)}s`;
const NEW_PREFIX = "new:";
const label = (c: SnapClip) => `"${c.name}"${c.id && !c.id.startsWith(NEW_PREFIX) ? ` [${c.id}]` : ""}`;

const MAX_LINES = 40;

// Human-readable list of what changed between two snapshots of one sequence.
function diff(before: Snap, after: Snap): string[] {
  const out: string[] = [];
  if (before.tracks.video !== after.tracks.video || before.tracks.audio !== after.tracks.audio) {
    out.push(`tracks: ${before.tracks.video}V/${before.tracks.audio}A → ${after.tracks.video}V/${after.tracks.audio}A`);
  }
  const a = keyed(before), b = keyed(after);
  for (const [k, c] of b) {
    const old = a.get(k);
    if (!old) {
      out.push(`added ${label(c)} ${where(c)}`);
      continue;
    }
    const parts: string[] = [];
    if (old.track !== c.track || old.start !== c.start || old.end !== c.end) parts.push(`${where(old)} → ${where(c)}`);
    if (old.sourceIn !== c.sourceIn) parts.push(`source in ${fmt(old.sourceIn)} → ${fmt(c.sourceIn)}s`);
    if ((old.speed ?? 1) !== (c.speed ?? 1)) parts.push(`speed ${old.speed ?? 1} → ${c.speed ?? 1}`);
    if ((old.enabled ?? true) !== (c.enabled ?? true)) parts.push(c.enabled === false ? "disabled" : "enabled");
    if (old.name !== c.name) parts.push(`renamed from "${old.name}"`);
    if (parts.length) out.push(`${label(c)} ${parts.join(", ")}`);
  }
  for (const [k, c] of a) if (!b.has(k)) out.push(`removed ${label(c)} ${where(c)}`);
  if (out.length > MAX_LINES) {
    const more = out.length - MAX_LINES;
    out.length = MAX_LINES;
    out.push(`…and ${more} more (call get_timeline_clips for the full timeline)`);
  }
  return out;
}

// Changes on a preview copy carry the copy's clip IDs; give clips the IDs of
// their twins in the original (same position before the edit).
function mapPreviewIds(previewBefore: Snap, previewAfter: Snap, original: Snap) {
  const pos = (c: SnapClip) => `${c.trackType}|${c.trackIndex}|${c.clipIndex}`;
  const origByPos = new Map(original.clips.map((c) => [pos(c), c.id]));
  const idMap = new Map<string, string | null>();
  for (const c of previewBefore.clips) if (c.id) idMap.set(c.id, origByPos.get(pos(c)) ?? null);
  for (const snap of [previewBefore, previewAfter]) {
    for (const c of snap.clips) {
      if (!c.id) continue;
      if (idMap.has(c.id)) c.id = idMap.get(c.id) ?? null;
      else c.id = NEW_PREFIX + c.id; // made by the edit: no clip in the original yet
    }
  }
}

/* ---------- clip IDs ---------- */

async function resolveClipIds(name: string, args: Ctx, hasTrackType: boolean) {
  const single = typeof args.clipId === "string" && args.clipId !== "";
  const list = Array.isArray(args.clips) ? (args.clips as Ctx[]) : [];
  const ids = [...(single ? [args.clipId as string] : []), ...list.filter((c) => c && c.clipId).map((c) => c.clipId as string)];
  if (ids.length) {
    const locs = (await callPremiere("resolveClipIds", [ids])) as Loc[];
    let i = 0;
    const apply = (target: Ctx, loc: Loc) => {
      target.trackType = loc.trackType;
      target.trackIndex = loc.trackIndex;
      target.clipIndex = loc.clipIndex;
    };
    if (single) {
      const loc = locs[i++];
      const needs = AUDIO_CLIP_TOOLS.has(name) ? "audio" : !hasTrackType ? "video" : null;
      if (needs && loc.trackType !== needs) {
        throw new Error(`clipId ${args.clipId} is on ${loc.trackType === "video" ? "a video" : "an audio"} track; ${name} needs ${needs === "audio" ? "an audio" : "a video"} clip.`);
      }
      apply(args, loc);
      if (!hasTrackType) delete args.trackType;
    }
    for (const c of list) if (c && c.clipId) apply(c, locs[i++]);
  }
  for (const c of list) {
    if (c && (c.trackType === undefined || c.trackIndex === undefined || c.clipIndex === undefined)) {
      throw new Error("Each clip needs a clipId, or trackType + trackIndex + clipIndex.");
    }
  }
}

/* ---------- the wrapper ---------- */

type Content = { type: string; text?: string; [k: string]: unknown };
type ToolResult = { content: Content[]; isError?: boolean };

function withNote(result: ToolResult, note: Record<string, unknown>): ToolResult {
  if (!Object.keys(note).length) return result;
  return { ...result, content: [...(result.content ?? []), { type: "text", text: JSON.stringify(note, null, 2) }] };
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

async function runEdit(name: string, args: Ctx, call: () => Promise<ToolResult>): Promise<ToolResult> {
  const note: Record<string, unknown> = {};
  const before = await snapshot();

  // Someone edited this sequence since prmcp last saw it (by hand, or another session).
  if (before) {
    const seen = lastSeen.get(before.sequenceId);
    if (seen) {
      const outside = diff(seen, before);
      if (outside.length) {
        note.changedOutsidePrmcp = outside;
        note.warning = "The timeline was edited outside prmcp since the last call. Clip indexes may have moved; prefer clipId.";
      }
    }
  }

  // The flags this layer added to the schema; other tools may use the same names
  // for their own arguments (restore_checkpoint's `checkpoint`).
  const dryRun = DRY_RUN_TOOLS.has(name) && args.dry_run === true;
  if (DRY_RUN_TOOLS.has(name)) delete args.dry_run;
  const wantCheckpoint = !CHECKPOINT_TOOLS[name] || args.checkpoint !== false;
  if (CHECKPOINT_TOOLS[name]) delete args.checkpoint;

  if (dryRun) {
    if (!before) throw new Error("No active sequence to preview the edit on.");
    const dr = (await callPremiere("beginDryRun", [])) as { previewId: string; originalId: string };
    let result: ToolResult | undefined;
    let failure: string | undefined;
    let changes: string[] = [];
    try {
      const pBefore = await snapshot();
      try {
        result = await call();
      } catch (e) {
        failure = errorText(e);
      }
      const pAfter = await snapshot();
      if (pBefore && pAfter) {
        mapPreviewIds(pBefore, pAfter, before);
        changes = diff(pBefore, pAfter);
      }
    } finally {
      await callPremiere("endDryRun", [dr.previewId, dr.originalId]);
    }
    lastSeen.set(before.sequenceId, before);
    const preview: Record<string, unknown> = {
      dryRun: true,
      note: "Nothing was changed. This is what the edit would do, tried on a temporary copy of the sequence (now deleted).",
      wouldChange: changes.length ? changes : ["no clip changes"],
    };
    if (failure) preview.wouldFail = failure;
    return withNote({ content: result?.content ?? [] }, { ...preview, ...note });
  }

  let checkpoint: { name: string; id: string; ofId: string } | undefined;
  const risky = CHECKPOINT_TOOLS[name];
  if (risky && risky(args) && wantCheckpoint && before) {
    checkpoint = (await callPremiere("createCheckpoint", [name.replace(/_/g, " ")])) as typeof checkpoint;
  }

  let result: ToolResult;
  try {
    result = await call();
    if (result?.isError && checkpoint) throw new Error((result.content?.[0]?.text as string) || "Edit failed");
  } catch (e) {
    if (!checkpoint) throw e;
    let rolledBack = false;
    try {
      await callPremiere("restoreCheckpoint", [checkpoint.id, checkpoint.ofId]);
      rolledBack = true;
    } catch {}
    lastSeen.delete(before!.sequenceId);
    throw new Error(
      `${errorText(e)}\n` +
        (rolledBack
          ? "The sequence was rolled back to how it was before this edit."
          : `Rolling back failed; restore_checkpoint "${checkpoint.name}" puts the sequence back as it was.`)
    );
  }

  const after = await snapshot();
  if (after) {
    lastSeen.set(after.sequenceId, after);
    if (before && before.sequenceId === after.sequenceId) {
      const changes = diff(before, after);
      note.changes = changes.length ? changes : ["no clip changes"];
    } else if (before) {
      note.activeSequence = `now "${after.sequenceName}" (was "${before.sequenceName}")`;
    }
  }
  if (checkpoint) {
    note.checkpoint = checkpoint.name;
    note.revert = "restore_checkpoint with this checkpoint undoes the whole edit in one step";
  }
  return withNote(result, note);
}

function extendShape(name: string, shape: Record<string, z.ZodTypeAny>) {
  const out: Record<string, z.ZodTypeAny> = { ...shape };
  if ("clipIndex" in shape && "trackIndex" in shape) {
    out.clipId = clipIdSchema.optional();
    for (const k of ["trackType", "trackIndex", "clipIndex"]) if (out[k]) out[k] = out[k].optional();
  }
  if (DRY_RUN_TOOLS.has(name)) {
    out.dry_run = z.boolean().optional().describe("Only report what the edit would change; nothing is changed");
  }
  if (CHECKPOINT_TOOLS[name]) {
    out.checkpoint = z
      .boolean()
      .optional()
      .describe("Copy the sequence first so the whole edit can be undone with restore_checkpoint, and roll back if it fails (default true)");
  }
  return out;
}

function extendDescription(name: string, description: string) {
  let d = description;
  if (CHECKPOINT_TOOLS[name]) d += ". Checkpointed: reversible in one step with restore_checkpoint, rolled back automatically if it fails.";
  if (DRY_RUN_TOOLS.has(name)) d += " dry_run=true previews the changes without editing.";
  return d;
}

function hasClipArgs(shape: Record<string, unknown>) {
  return ("clipIndex" in shape && "trackIndex" in shape) || "clips" in shape;
}

// Wrap server.tool so every tool registered afterwards goes through the safety layer.
export function installSafety(server: McpServer) {
  const original = server.tool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (...a: unknown[]) => {
    const name = a[0] as string;
    const handler = a[a.length - 1] as (args: Ctx, extra: unknown) => Promise<ToolResult>;
    const shapeAt = a.length - 2;
    const shape = shapeAt >= 1 && typeof a[shapeAt] === "object" && a[shapeAt] !== null ? (a[shapeAt] as Record<string, z.ZodTypeAny>) : null;
    const descAt = typeof a[1] === "string" ? 1 : -1;

    const rest = [...a];
    if (shape) rest[shapeAt] = extendShape(name, shape);
    if (descAt > 0) rest[descAt] = extendDescription(name, a[descAt] as string);

    const isEdit = EDIT_TOOLS.has(name);
    const isRead = TIMELINE_READS.has(name);
    const resolves = !!shape && hasClipArgs(shape);

    rest[rest.length - 1] = (args: Ctx = {}, extra: unknown) => {
      if (name === "get_status") return handler(args, extra);
      return serial(async () => {
        if (resolves) {
          const s = shape as Record<string, z.ZodTypeAny>;
          await resolveClipIds(name, args, "trackType" in s);
          if (s.clipIndex && !s.clipIndex.isOptional() && args.clipIndex === undefined) {
            throw new Error("Give the clip as clipId, or as trackType + trackIndex + clipIndex (see get_timeline_clips).");
          }
          delete args.clipId;
        }
        if (isEdit) return runEdit(name, args, () => handler(args, extra));
        const result = await handler(args, extra);
        if (isRead) {
          const s = await snapshot();
          if (s) lastSeen.set(s.sequenceId, s);
        }
        return result;
      });
    };
    return original(...rest);
  };
}
