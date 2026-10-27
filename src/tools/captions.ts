import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFile } from "fs/promises";
import { join } from "path";
import { callPremiere, run, toolResult } from "../bridge.js";
import { outputDir, safeName } from "./common.js";
import { placeText, textStyle } from "./graphics.js";

const cue = z.object({
  start: z.number().min(0).describe("Seconds"),
  end: z.number().min(0).describe("Seconds"),
  text: z.string(),
});

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function toSrt(cues: { start: number; end: number; text: string }[]): string {
  return (
    cues
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text.trim()}\n`)
      .join("\n") + "\n"
  );
}

export async function captionsFromCues(cues: { start: number; end: number; text: string }[], name: string, format = "subtitle") {
  const bad = cues.find((c) => c.end <= c.start);
  if (bad) throw new Error(`Caption "${bad.text}" ends before it starts`);
  const file = join(await outputDir("captions"), `${safeName(name)}_${Date.now()}.srt`);
  await writeFile(file, toSrt(cues), "utf8");
  const res = await callPremiere("createCaptionTrack", [file, 0, format], 120_000);
  return { ...res, srtFile: file, cues: cues.length };
}

export function registerCaptionTools(server: McpServer) {
  server.tool(
    "add_captions",
    "Create a caption (subtitle) track on the active sequence from timed text. These are real Premiere captions: editable and stylable in the Text panel, exportable as SRT, burnable on export. Right-to-left text works.",
    {
      captions: z.array(cue).min(1),
      name: z.string().optional().describe("Name for the caption file (default: 'captions')"),
      format: z.enum(["subtitle", "cea608", "cea708", "teletext", "ebu", "op42", "op47"]).optional(),
    },
    async ({ captions, name, format }) => toolResult(await captionsFromCues(captions, name ?? "captions", format ?? "subtitle"))
  );

  server.tool(
    "import_captions",
    "Create a caption track from an existing caption file (.srt, .scc, .mcc, .xml, .stl)",
    {
      filePath: z.string(),
      start: z.number().min(0).optional().describe("Sequence time where the file's 00:00:00 lands (default 0)"),
      format: z.enum(["subtitle", "cea608", "cea708", "teletext", "ebu", "op42", "op47"]).optional(),
    },
    ({ filePath, start, format }) => run("createCaptionTrack", [filePath, start ?? 0, format ?? "subtitle"], 120_000)
  );

  server.tool(
    "add_text_captions",
    "Burned-in styled captions as graphics clips (TikTok/Reels style): each cue becomes a text image on the timeline. Use add_captions instead when you want editable Premiere captions.",
    {
      captions: z.array(cue).min(1),
      trackIndex: z.number().int().min(0).optional().describe("Video track (default: first free track above V1)"),
      ...textStyle,
    },
    async ({ captions, trackIndex, ...style }) => {
      const s = await callPremiere("getSequenceSettings");
      const size = { w: s.width, h: s.height };
      const first = Math.min(...captions.map((c) => c.start));
      const last = Math.max(...captions.map((c) => c.end));
      const track = trackIndex ?? (await callPremiere("findFreeVideoTrack", [first, last, 1])).trackIndex;
      const placed = [];
      for (const c of captions) {
        if (c.end <= c.start) throw new Error(`Caption "${c.text}" ends before it starts`);
        const r = await placeText(c.text, c.start, c.end - c.start, { ...style, fontSize: style.fontSize ?? Math.round(size.h * 0.06) }, track, size);
        placed.push({ text: c.text, start: r.start, end: r.end, clipIndex: r.clipIndex });
      }
      return toolResult({ trackIndex: track, placed: placed.length, clips: placed });
    }
  );
}
