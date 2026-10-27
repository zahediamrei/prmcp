import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";
import { homedir, platform } from "os";
import { callPremiere, run, toolResult } from "../bridge.js";
import { outputDir, safeName } from "./common.js";
import { renderText } from "../textRender.js";
import { buildAegraphicVariant, buildVariant, capsuleIdFromPath, findDefinition, footageFiles, listLibraryGraphics, loadLibraryGraphic, loadMogrtFile, mediaSlots, MogrtPackage, packageMogrt } from "../mogrt.js";

const templateSource = {
  mogrtPath: z.string().optional().describe("Path to a .mogrt file"),
  library: z.string().optional().describe("Creative Cloud Library name (with library graphics)"),
  graphic: z.string().optional().describe("Graphic name in the library, e.g. 'Lower Third'"),
};

async function loadTemplate(a: { mogrtPath?: string; library?: string; graphic?: string }): Promise<MogrtPackage> {
  if (a.mogrtPath) return loadMogrtFile(a.mogrtPath);
  if (a.graphic) return loadLibraryGraphic(a.library, a.graphic);
  throw new Error("Give mogrtPath, or graphic (and optionally library)");
}

async function applyProps(trackIndex: number, clipIndex: number, props?: Record<string, string | number | boolean | number[]>) {
  let last: any = null;
  for (const [k, v] of Object.entries(props ?? {})) {
    const key: string | number = /^\d+$/.test(k) ? Number(k) : k;
    last = await callPremiere("setMogrtProperty", [trackIndex, clipIndex, key, v, null]);
  }
  return last?.properties;
}

const positions: Record<string, [number, number]> = {
  top: [0.5, 0.12],
  center: [0.5, 0.5],
  bottom: [0.5, 0.82],
  "lower-third": [0.3, 0.8],
  "top-left": [0.25, 0.1],
  "top-right": [0.75, 0.1],
  "bottom-left": [0.25, 0.88],
  "bottom-right": [0.75, 0.88],
};

export const textStyle = {
  font: z.string().optional().describe("Installed font name or PostScript name, e.g. 'Vazirmatn', 'Helvetica Neue', 'Arial-BoldMT' (default: bold system font)"),
  fontSize: z.number().positive().optional().describe("Pixels (default: 7% of frame height)"),
  color: z.string().optional().describe("Text color #rrggbb (default #ffffff)"),
  strokeColor: z.string().optional().describe("Outline color #rrggbb"),
  strokeWidth: z.number().min(0).optional().describe("Outline width in pixels"),
  backgroundColor: z.string().optional().describe("Box behind the text #rrggbb (caption/TikTok style)"),
  backgroundOpacity: z.number().min(0).max(1).optional(),
  shadow: z.boolean().optional().describe("Drop shadow (default true)"),
  position: z
    .enum(["top", "center", "bottom", "lower-third", "top-left", "top-right", "bottom-left", "bottom-right"])
    .optional()
    .describe("Default bottom"),
  x: z.number().min(0).max(1).optional().describe("Custom horizontal center (0-1 of width), overrides position"),
  y: z.number().min(0).max(1).optional().describe("Custom vertical center (0-1 of height, 0 = top), overrides position"),
  align: z.enum(["left", "center", "right"]).optional(),
  maxWidth: z.number().min(0.1).max(1).optional().describe("Wrap width as a fraction of the frame (default 0.85)"),
};

type Style = { [K in keyof typeof textStyle]?: any };

let sequenceSize: { w: number; h: number; name: string } | null = null;

async function frameSize() {
  const s = await callPremiere("getSequenceSettings");
  sequenceSize = { w: s.width, h: s.height, name: s.name };
  return sequenceSize;
}

// Render text to a PNG, import it and place it on the timeline.
export async function placeText(text: string, start: number, duration: number, style: Style, trackIndex?: number, size?: { w: number; h: number }) {
  const fs = size ?? (await frameSize());
  const [px, py] = positions[style.position ?? "bottom"];
  const file = join(await outputDir("text"), `${safeName(text, 30)}_${Date.now()}.png`);
  await renderText({
    text,
    width: fs.w,
    height: fs.h,
    font: style.font,
    fontSize: style.fontSize ?? Math.round(fs.h * 0.07),
    color: style.color ?? "#ffffff",
    strokeColor: style.strokeColor,
    strokeWidth: style.strokeWidth,
    backgroundColor: style.backgroundColor,
    backgroundOpacity: style.backgroundOpacity,
    shadow: style.shadow ?? !style.backgroundColor,
    align: style.align ?? "center",
    x: style.x ?? px,
    y: style.y ?? py,
    maxWidth: style.maxWidth ?? 0.85,
    out: file,
  });
  const imported = await callPremiere("importMedia", [[file], "Titles", false]).catch(async (e) => {
    if (!/Bin not found/.test(String(e))) throw e;
    await callPremiere("createBin", ["Titles", ""]);
    return callPremiere("importMedia", [[file], "Titles", false]);
  });
  const nodeId = imported.imported[0]?.nodeId;
  if (!nodeId) throw new Error("Rendered text image could not be imported");
  const track = trackIndex ?? (await callPremiere("findFreeVideoTrack", [start, start + duration, 1])).trackIndex;
  const placed = await callPremiere("placeStill", [nodeId, track, start, duration]);
  return { text, file, ...placed };
}

async function scanMogrts(): Promise<{ name: string; path: string }[]> {
  const dirs: string[] = [];
  const appsRoot = platform() === "darwin" ? "/Applications" : "C:/Program Files/Adobe";
  try {
    for (const n of (await readdir(appsRoot)).filter((n) => n.startsWith("Adobe Premiere Pro")).sort().reverse()) {
      dirs.push(platform() === "darwin" ? join(appsRoot, n, `${n}.app`, "Contents", "Essential Graphics") : join(appsRoot, n, "Essential Graphics"));
      break;
    }
  } catch {}
  dirs.push(
    platform() === "darwin"
      ? join(homedir(), "Library", "Application Support", "Adobe", "Common", "Motion Graphics Templates")
      : join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Adobe", "Common", "Motion Graphics Templates")
  );
  const out: { name: string; path: string }[] = [];
  async function walk(d: string, depth: number) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name.endsWith(".mogrt")) out.push({ name: basename(e.name, ".mogrt"), path: p });
    }
  }
  for (const d of dirs) await walk(d, 0);
  return out;
}

export function registerGraphicsTools(server: McpServer) {
  server.tool(
    "add_text",
    "Add a text title to the timeline (rendered with the system text engine: any installed font, right-to-left scripts supported). Placed on a free video track above V1 unless trackIndex is given. To change it later, remove the clip and add it again.",
    {
      text: z.string().describe("Text; use \\n for line breaks"),
      start: z.number().min(0).describe("Seconds"),
      duration: z.number().positive().describe("Seconds"),
      trackIndex: z.number().int().min(0).optional(),
      ...textStyle,
    },
    async ({ text, start, duration, trackIndex, ...style }) => toolResult(await placeText(text, start, duration, style, trackIndex))
  );

  server.tool(
    "list_mogrts",
    "Motion Graphics templates (.mogrt) installed with Premiere and in your Essential Graphics library",
    { filter: z.string().optional() },
    async ({ filter }) => {
      const f = (filter ?? "").toLowerCase();
      const list = (await scanMogrts()).filter((m) => !f || m.path.toLowerCase().includes(f));
      return toolResult({
        count: list.length,
        note: "Templates marked [AE] (After Effects based) have editable text/colors via set_mogrt_property; Premiere-made titles do not.",
        mogrts: list,
      });
    }
  );

  server.tool(
    "import_mogrt",
    "Place a Motion Graphics template on a video track. Returns its editable properties.",
    {
      mogrtPath: z.string(),
      trackIndex: z.number().int().min(0),
      start: z.number().min(0).describe("Seconds"),
      duration: z.number().positive().optional().describe("Seconds (default: template length)"),
    },
    ({ mogrtPath, trackIndex, start, duration }) => run("importMogrt", [mogrtPath, trackIndex, start, duration], 120_000)
  );

  server.tool(
    "list_library_graphics",
    "Motion Graphics templates stored in your Creative Cloud Libraries",
    { filter: z.string().optional() },
    async ({ filter }) => {
      const f = (filter ?? "").toLowerCase();
      return toolResult((await listLibraryGraphics()).filter((g) => !f || `${g.library} ${g.name}`.toLowerCase().includes(f)));
    }
  );

  server.tool(
    "import_library_graphic",
    "Place a graphic from a Creative Cloud Library on a video track, optionally setting its text/values right away",
    {
      library: z.string().describe("Library name exactly as in the Libraries panel"),
      graphic: z.string(),
      trackIndex: z.number().int().min(0),
      start: z.number().min(0),
      duration: z.number().positive().optional(),
      properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.number())])).optional().describe("Property name (or index) -> value, e.g. {\"Text\": \"...\"}"),
    },
    async ({ library, graphic, trackIndex, start, duration, properties }) => {
      // Premiere needs the exact names (library names can contain double spaces).
      const n = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();
      const hit = (await listLibraryGraphics()).find((g) => n(g.library) === n(library) && n(g.name) === n(graphic));
      const placed = await callPremiere("importLibraryGraphic", [hit?.library ?? library, hit?.name ?? graphic, trackIndex, start, duration], 180_000);
      const props = await applyProps(trackIndex, placed.clipIndex, properties);
      return toolResult(props ? { ...placed, properties: props } : placed);
    }
  );

  server.tool(
    "get_mogrt_media",
    "The replaceable media slots (Media Replacement) of an After Effects .mogrt, a library graphic, or a template clip on the timeline (trackIndex + clipIndex), and the images behind them",
    { ...templateSource, trackIndex: z.number().int().min(0).optional(), clipIndex: z.number().int().min(0).optional() },
    async (a) => {
      let pkg: MogrtPackage;
      let extra: any = {};
      if (a.trackIndex !== undefined && a.clipIndex !== undefined) {
        const src = await callPremiere("getMogrtClipSource", [a.trackIndex, a.clipIndex]);
        const capsule = capsuleIdFromPath(src.aegraphicPath) ?? "";
        const definition = (await findDefinition(capsule, src.aegraphicPath)) ?? { capsuleName: src.name, clientControls: [] };
        pkg = { definition, aegraphic: await readFile(src.aegraphicPath), extras: [], source: src.aegraphicPath };
        extra = { clipsUsingThisTemplate: src.usage, overriddenInEssentialGraphics: src.mediaSlots.filter((s: any) => s.overridden).map((s: any) => s.name) };
      } else {
        pkg = await loadTemplate(a);
      }
      return toolResult({ template: pkg.definition.capsuleName, source: pkg.source, slots: mediaSlots(pkg), files: footageFiles(pkg), ...extra });
    }
  );

  server.tool(
    "place_mogrt_with_media",
    "Place an After Effects .mogrt / library graphic with your own images in its Media Replacement slots (and set its text). Builds a copy of the template with the images inside, so it renders like a normal template. Slots that share one image in the template change together.",
    {
      ...templateSource,
      replacements: z
        .array(
          z.object({
            slot: z.string().optional().describe("Media slot name from get_mogrt_media, e.g. 'IMG Main'"),
            file: z.string().optional().describe("Or the image path inside the template (get_mogrt_media 'files')"),
            image: z.string().describe("Absolute path of your image (jpg/png)"),
            fit: z.enum(["cover", "contain"]).optional().describe("cover = fill and crop (default), contain = fit with black bars"),
          })
        )
        .min(1),
      trackIndex: z.number().int().min(0),
      start: z.number().min(0),
      duration: z.number().positive().optional(),
      properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.number())])).optional().describe("Other template properties to set, e.g. {\"Text\": \"...\"}"),
      label: z.string().optional().describe("Suffix for the generated template name"),
    },
    async ({ mogrtPath, library, graphic, replacements, trackIndex, start, duration, properties, label }) => {
      const pkg = await loadTemplate({ mogrtPath, library, graphic });
      const variant = await buildVariant(pkg, replacements, await outputDir("mogrt"), label);
      const placed = await callPremiere("importMogrt", [variant.mogrtPath, trackIndex, start, duration], 180_000);
      const props = await applyProps(trackIndex, placed.clipIndex, properties);
      return toolResult({ ...variant, ...placed, properties: props ?? placed.properties });
    }
  );

  const replacementSchema = z
    .array(
      z.object({
        slot: z.string().optional().describe("Media slot name, e.g. 'IMG Main'"),
        file: z.string().optional().describe("Or the image path inside the template (get_mogrt_media)"),
        image: z.string().describe("Absolute path of your image (jpg/png)"),
        fit: z.enum(["cover", "contain"]).optional().describe("cover = fill and crop (default), contain = fit with black bars"),
      })
    )
    .min(1);

  server.tool(
    "replace_mogrt_media",
    "Replace the image in a Media Replacement slot of a template clip that is already on the timeline. The clip stays in place with its text, settings, effects and keyframes. If other clips use the same template, by default only this clip changes (it is swapped for an identical copy with its settings carried over); scope 'all' changes every clip of that template in place instead.",
    {
      trackIndex: z.number().int().min(0).describe("Video track of the template clip"),
      clipIndex: z.number().int().min(0),
      replacements: replacementSchema,
      scope: z.enum(["clip", "all"]).optional().describe("clip (default) = only this clip; all = every clip using this template"),
    },
    async ({ trackIndex, clipIndex, replacements, scope }) => {
      const src = await callPremiere("getMogrtClipSource", [trackIndex, clipIndex]);
      const capsule = capsuleIdFromPath(src.aegraphicPath);
      if (!capsule) throw new Error(`Unexpected template location: ${src.aegraphicPath}`);
      const variant = await buildAegraphicVariant(src.aegraphicPath, capsule, replacements);
      if (src.usage <= 1 || scope === "all") {
        const res = await callPremiere("relinkMogrtClip", [trackIndex, clipIndex, variant.aegraphicPath, variant.replacedSlots], 180_000);
        return toolResult({ method: "in place", clipsChanged: src.usage, replacedSlots: variant.replacedSlots, ...res });
      }
      const def = await findDefinition(capsule, src.aegraphicPath);
      if (!def) {
        throw new Error(`${src.usage} clips use this template and its definition wasn't found to make a separate copy. Use scope 'all' to change all of them.`);
      }
      const mogrt = await packageMogrt(def, variant.aegraphicPath, replacements.map((r) => basename(r.image).replace(/\.[^.]+$/, "")).join("_").slice(0, 30));
      const res = await callPremiere("swapMogrtClip", [trackIndex, clipIndex, mogrt], 180_000);
      return toolResult({ method: "separate copy (other clips share this template)", replacedSlots: variant.replacedSlots, mogrtPath: mogrt, ...res });
    }
  );

  server.tool(
    "get_mogrt_properties",
    "Editable properties (text, colors, sliders, checkboxes) of a Motion Graphics template clip",
    { trackIndex: z.number().int().min(0), clipIndex: z.number().int().min(0) },
    ({ trackIndex, clipIndex }) => run("getMogrtProperties", [trackIndex, clipIndex])
  );

  server.tool(
    "set_mogrt_property",
    "Change a Motion Graphics template property: text (string), color ('#rrggbb'), number or boolean",
    {
      trackIndex: z.number().int().min(0),
      clipIndex: z.number().int().min(0),
      property: z.union([z.string(), z.number().int()]).describe("Property name or index from get_mogrt_properties (use the index when names repeat)"),
      value: z.union([z.string(), z.number(), z.boolean(), z.array(z.number())]),
      fontSize: z.number().positive().optional().describe("For text properties"),
    },
    (a) => run("setMogrtProperty", [a.trackIndex, a.clipIndex, a.property, a.value, a.fontSize])
  );
}
