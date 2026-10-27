import { z } from "zod";
import { homedir } from "os";
import { join } from "path";
import { mkdir } from "fs/promises";

export const trackType = z.enum(["video", "audio"]).describe("Track type");
export const trackIndex = z.number().int().min(0).describe("Track index, 0-based (V1 = 0, A1 = 0)");
export const clipIndex = z.number().int().min(0).describe("Clip index on the track, 0-based from the left (see get_timeline_clips)");
export const seconds = (what: string) => z.number().describe(`${what} in seconds`);

export const clip = {
  trackType,
  trackIndex,
  clipIndex,
};

export const clipId = z
  .string()
  .describe("Stable clip ID from get_timeline_clips; it stays valid after other edits, unlike clipIndex. Use it instead of trackType + trackIndex + clipIndex.");

export const clipRef = z.object({
  clipId: clipId.optional(),
  trackType: trackType.optional(),
  trackIndex: trackIndex.optional(),
  clipIndex: clipIndex.optional(),
});

export const effectRef = z
  .union([z.string(), z.number().int()])
  .describe("Effect name (e.g. 'Motion', 'Opacity', 'Gaussian Blur') or its index from get_clip_effects");

export const propertyRef = z
  .union([z.string(), z.number().int()])
  .describe("Property name (e.g. 'Scale', 'Position') or its index from get_clip_effects");

// Folder for files this server generates (text images, captions, voiceovers).
// Media referenced by a project must outlive the session, so not a temp dir.
export async function outputDir(sub: string): Promise<string> {
  const dir = join(homedir(), "Documents", "Premiere Connector", sub);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function safeName(s: string, max = 40): string {
  return (
    s
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, max) || "item"
  );
}
