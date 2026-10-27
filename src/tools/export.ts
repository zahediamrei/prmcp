import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdir, readFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir, platform, tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { callPremiere, run, toolResult } from "../bridge.js";
import { outputDir } from "./common.js";

const exec = promisify(execFile);
const EXPORT_TIMEOUT = 3 * 60 * 60 * 1000;

export interface Preset {
  name: string;
  format: string;
  path: string;
  source: string;
}

// AME preset folders are named <vendor>_<format> as hex FourCCs.
function formatFromFolder(folder: string): string {
  const m = folder.match(/^[0-9a-f]{8}_([0-9a-f]{8})$/i);
  if (!m) return folder;
  const s = Buffer.from(m[1], "hex").toString("latin1").trim();
  const names: Record<string, string> = { H264: "H.264", H26B: "H.264 (Blu-ray)", HEVC: "HEVC (H.265)", MooV: "QuickTime", WAVE: "WAV", "PNG": "PNG", JPEG: "JPEG", MP3: "MP3", AAC: "AAC", TIFF: "TIFF", DIBB: "BMP", GIFf: "GIF", AIFF: "AIFF", AVIV: "AVI", MP4: "MPEG-4", mpg2: "MPEG-2", flv: "FLV", JMXF: "MXF OP1a", PMXF: "MXF OP1a", DMXF: "MXF DNx", MXFX: "XDCAM", DCP_: "DCP" };
  return names[s] ?? s;
}

async function walk(dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 6) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, depth + 1, out);
    else if (e.name.toLowerCase().endsWith(".epr")) out.push(p);
  }
  return out;
}

async function appDirs(prefix: string): Promise<string[]> {
  const root = platform() === "darwin" ? "/Applications" : "C:/Program Files/Adobe";
  try {
    const names = (await readdir(root)).filter((n) => n.startsWith(prefix)).sort().reverse();
    return names.map((n) => join(root, n));
  } catch {
    return [];
  }
}

let presetCache: Preset[] | null = null;

export async function listPresets(): Promise<Preset[]> {
  if (presetCache) return presetCache;
  const roots: { dir: string; source: string }[] = [];
  for (const d of await appDirs("Adobe Media Encoder")) {
    const app = platform() === "darwin" ? join(d, `${basename(d)}.app`, "Contents") : d;
    roots.push({ dir: join(app, "MediaIO", "systempresets"), source: "Media Encoder" });
  }
  for (const d of await appDirs("Adobe Premiere Pro")) {
    const app = platform() === "darwin" ? join(d, `${basename(d)}.app`, "Contents") : d;
    roots.push({ dir: join(app, "Settings", "EncoderPresets"), source: "Premiere Pro" });
    roots.push({ dir: join(app, "Settings", "IngestPresets"), source: "Premiere Pro ingest/proxy" });
  }
  const userAme = join(homedir(), "Documents", "Adobe", "Adobe Media Encoder");
  try {
    for (const v of await readdir(userAme)) roots.push({ dir: join(userAme, v, "Presets"), source: "User presets" });
  } catch {}

  const presets: Preset[] = [];
  const seen = new Set<string>();
  for (const r of roots) {
    for (const p of await walk(r.dir)) {
      const name = basename(p, ".epr");
      const format = formatFromFolder(basename(dirname(p)));
      const key = `${r.source}|${format}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      presets.push({ name, format, path: p, source: r.source });
    }
  }
  presetCache = presets;
  return presets;
}

async function findPreset(pred: (p: Preset) => boolean): Promise<Preset | undefined> {
  return (await listPresets()).find(pred);
}

export async function defaultVideoPreset(): Promise<string> {
  const p =
    (await findPreset((p) => p.format === "H.264" && /^01 - Match Source - High bitrate$/i.test(p.name))) ??
    (await findPreset((p) => p.format === "H.264" && /Match Source - High bitrate/i.test(p.name))) ??
    (await findPreset((p) => p.format === "H.264" && /High Quality 1080/i.test(p.name)));
  if (!p) throw new Error("No H.264 export preset found. Pass presetPath (see get_export_presets).");
  return p.path;
}

async function pngPreset(): Promise<string> {
  const p = await findPreset((p) => p.format === "PNG" && /^PNG Sequence \(Match Source\)$/i.test(p.name));
  if (!p) throw new Error("PNG export preset not found (Adobe Media Encoder must be installed).");
  return p.path;
}

async function resolvePreset(preset?: string): Promise<string> {
  if (!preset) return defaultVideoPreset();
  if (existsSync(preset)) return preset;
  const want = preset.toLowerCase();
  const all = await listPresets();
  const exact = all.find((p) => p.name.toLowerCase() === want);
  if (exact) return exact.path;
  const partial = all.filter((p) => `${p.format} ${p.name}`.toLowerCase().includes(want));
  if (partial.length === 1) return partial[0].path;
  if (partial.length > 1) {
    throw new Error(`'${preset}' matches several presets: ${partial.slice(0, 8).map((p) => `${p.format} / ${p.name}`).join("; ")}. Be more specific or pass the path.`);
  }
  throw new Error(`Preset '${preset}' not found. Use get_export_presets.`);
}

async function shrinkImage(path: string, maxWidth: number): Promise<Buffer> {
  if (platform() === "darwin") {
    const out = join(tmpdir(), `ppro-mcp-frame-${process.pid}-${Date.now()}.jpg`);
    try {
      await exec("sips", ["-Z", String(maxWidth), "-s", "format", "jpeg", "-s", "formatOptions", "80", path, "--out", out]);
      const buf = await readFile(out);
      return buf;
    } catch {
      // fall through to the original PNG
    } finally {
      unlink(out).catch(() => {});
    }
  }
  return readFile(path);
}

export function registerExportTools(server: McpServer) {
  server.tool(
    "get_export_presets",
    "Export presets installed with Premiere / Media Encoder (and your own). Filter by name or format, e.g. 'youtube', 'h.264', 'prores', 'wav', 'png'.",
    { filter: z.string().optional() },
    async ({ filter }) => {
      const f = (filter ?? "").toLowerCase();
      const list = (await listPresets()).filter((p) => !f || `${p.format} ${p.name} ${p.source}`.toLowerCase().includes(f));
      return toolResult({ count: list.length, presets: list.slice(0, 150) });
    }
  );

  server.tool(
    "export_sequence",
    "Render the active (or named) sequence to a file inside Premiere and wait until it is done. Default preset: H.264 Match Source - High bitrate.",
    {
      outputPath: z.string().describe("Absolute output file path, e.g. /Users/me/Desktop/final.mp4"),
      preset: z.string().optional().describe("Preset name (e.g. 'YouTube 1080p HD', 'Apple ProRes 422') or .epr path"),
      range: z.enum(["entire", "inOut", "workArea"]).optional().describe("Default entire"),
      sequence: z.string().optional().describe("Sequence name or ID (default: active)"),
    },
    async ({ outputPath, preset, range, sequence }) =>
      run("exportSequence", [outputPath, await resolvePreset(preset), range ?? "entire", sequence], EXPORT_TIMEOUT)
  );

  server.tool(
    "queue_export",
    "Send the sequence to Adobe Media Encoder's queue (renders in the background while you keep editing)",
    {
      outputPath: z.string(),
      preset: z.string().optional(),
      range: z.enum(["entire", "inOut", "workArea"]).optional(),
      startImmediately: z.boolean().optional().describe("Start the queue (default true)"),
      sequence: z.string().optional(),
    },
    async ({ outputPath, preset, range, startImmediately, sequence }) =>
      run("queueExport", [outputPath, await resolvePreset(preset), range ?? "entire", startImmediately !== false, sequence], 120_000)
  );

  server.tool(
    "export_frame",
    "Render one frame of the active sequence (with all effects) and show it, so you can check how the edit looks. Also saved as PNG.",
    {
      time: z.number().min(0).optional().describe("Seconds (default: playhead)"),
      outputPath: z.string().optional().describe("Where to save the PNG (default: ~/Documents/Premiere Connector/frames)"),
      returnImage: z.boolean().optional().describe("Return the image to Claude (default true)"),
      maxWidth: z.number().int().min(160).max(3840).optional().describe("Width of the returned preview (default 960)"),
    },
    async ({ time, outputPath, returnImage, maxWidth }) => {
      const out = outputPath ?? join(await outputDir("frames"), `frame_${(time ?? 0).toFixed(2).replace(".", "_")}_${Date.now()}.png`);
      const res = await callPremiere("exportFrame", [time ?? -1, out, await pngPreset()], 300_000);
      const content: any[] = [{ type: "text", text: JSON.stringify(res, null, 2) }];
      if (returnImage !== false) {
        const buf = await shrinkImage(res.outputPath, maxWidth ?? 960);
        const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
        content.push({ type: "image", data: buf.toString("base64"), mimeType: isJpeg ? "image/jpeg" : "image/png" });
      }
      return { content };
    }
  );

  server.tool(
    "export_audio",
    "Export only the sequence audio (WAV 48 kHz 16-bit by default, or another audio preset)",
    { outputPath: z.string(), preset: z.string().optional(), range: z.enum(["entire", "inOut"]).optional() },
    async ({ outputPath, preset, range }) => {
      const p = preset
        ? await resolvePreset(preset)
        : (await findPreset((x) => x.format === "WAV" && /48kHz 16-bit/i.test(x.name)))?.path;
      if (!p) throw new Error("No WAV preset found; pass preset.");
      return run("exportSequence", [outputPath, p, range ?? "entire", null], EXPORT_TIMEOUT);
    }
  );

  server.tool("export_fcp_xml", "Export the active sequence as Final Cut Pro XML", { outputPath: z.string() }, ({ outputPath }) =>
    run("exportFinalCutXML", [outputPath], 300_000)
  );

  server.tool(
    "export_aaf",
    "Export the active sequence as AAF (for Avid / Pro Tools)",
    {
      outputPath: z.string(),
      mixdownAudio: z.boolean().optional(),
      explodeToMono: z.boolean().optional(),
      sampleRate: z.number().int().optional(),
      bitsPerSample: z.number().int().optional(),
    },
    (a) => run("exportAAF", [a.outputPath, a.mixdownAudio ?? false, a.explodeToMono ?? false, a.sampleRate ?? 48000, a.bitsPerSample ?? 16], 600_000)
  );

  server.tool(
    "export_omf",
    "Export the active sequence audio as OMF",
    { outputPath: z.string(), sampleRate: z.number().int().optional(), bitsPerSample: z.number().int().optional(), handleFrames: z.number().int().optional() },
    (a) => run("exportOMF", [a.outputPath, a.sampleRate ?? 48000, a.bitsPerSample ?? 16, a.handleFrames ?? 0], 600_000)
  );

  server.tool("export_sequence_as_project", "Save the active sequence (and its media references) as a separate .prproj", { outputPath: z.string() }, ({ outputPath }) =>
    run("exportProjectWithSequence", [outputPath], 300_000)
  );

  server.tool(
    "render_previews",
    "Render timeline previews (in to out, or 'all')",
    { range: z.enum(["inOut", "all"]).optional() },
    ({ range }) => run("renderPreviews", [range ?? "inOut"], EXPORT_TIMEOUT)
  );
}

