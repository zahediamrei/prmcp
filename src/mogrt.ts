// Media replacement for After Effects .mogrt templates.
//
// Premiere's scripting API cannot set a template's Media Replacement slot (the
// value it stores is an internal clip reference). Instead we build a copy of
// the template whose *default* image is the new one: an AE .mogrt is a zip
// holding definition.json and project.aegraphic (another zip with the .aep and
// its footage). The footage file behind a slot is swapped for the new image,
// resized to the original pixel size, and the copy gets a new capsuleID so
// Premiere doesn't reuse its cached render of the original.
import AdmZip from "adm-zip";
import { readdir, readFile, writeFile, unlink, stat, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, basename, extname, dirname } from "path";
import { homedir, platform, tmpdir } from "os";
import { randomUUID, createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

export interface MediaSlot {
  name: string;
  width: number;
  height: number;
  file?: string; // footage path inside project.aegraphic
  sharedWith?: string[];
}

export interface FootageFile {
  path: string;
  width: number;
  height: number;
}

export interface MogrtPackage {
  definition: any;
  aegraphic: Buffer;
  extras: { name: string; data: Buffer }[];
  source: string;
}

/* ---------- image size sniffing (PNG / JPEG) ---------- */

function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

const IMAGE_EXT = /\.(jpe?g|png)$/i;

/* ---------- loading templates ---------- */

export async function loadMogrtFile(path: string): Promise<MogrtPackage> {
  const zip = new AdmZip(path);
  const def = zip.getEntry("definition.json");
  const aeg = zip.getEntries().find((e) => e.entryName.endsWith(".aegraphic"));
  if (!def) throw new Error(`${basename(path)} is not a .mogrt (no definition.json)`);
  if (!aeg) throw new Error(`${basename(path)} was made in Premiere, not After Effects; its media can't be replaced this way`);
  const extras = zip
    .getEntries()
    .filter((e) => e !== def && e !== aeg && !e.isDirectory)
    .map((e) => ({ name: e.entryName, data: e.getData() }));
  return { definition: JSON.parse(def.getData().toString("utf8")), aegraphic: aeg.getData(), extras, source: path };
}

function librariesRoot(): string {
  return platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "Adobe", "Creative Cloud Libraries", "LIBS")
    : join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Adobe", "Creative Cloud Libraries", "LIBS");
}

async function libraryManifests(): Promise<{ dir: string; manifest: any }[]> {
  const out: { dir: string; manifest: any }[] = [];
  const root = librariesRoot();
  let accounts: string[] = [];
  try {
    accounts = await readdir(root);
  } catch {
    return out;
  }
  for (const acct of accounts) {
    const dcx = join(root, acct, "creative_cloud", "dcx");
    let libs: string[] = [];
    try {
      libs = await readdir(dcx);
    } catch {
      continue;
    }
    for (const lib of libs) {
      const m = join(dcx, lib, "manifest");
      if (!existsSync(m)) continue;
      try {
        out.push({ dir: join(dcx, lib), manifest: JSON.parse(await readFile(m, "utf8")) });
      } catch {}
    }
  }
  return out;
}

function* walkElements(node: any): Generator<any> {
  for (const child of node.children ?? []) {
    if (child.type === "application/vnd.adobe.element.graphic+dcx") yield child;
    yield* walkElements(child);
  }
}

export async function listLibraryGraphics(): Promise<{ library: string; name: string; madeIn: string }[]> {
  const out: { library: string; name: string; madeIn: string }[] = [];
  for (const { manifest } of await libraryManifests()) {
    for (const el of walkElements(manifest)) {
      const primary = (el.components ?? []).find((c: any) => c.rel === "primary");
      const madeIn = primary?.type?.includes("ae.graphic") ? "After Effects" : primary?.type?.includes("prgraphic") ? "Premiere" : "other";
      out.push({ library: manifest.name, name: el.name, madeIn });
    }
  }
  // The same library can be cached more than once.
  const seen = new Set<string>();
  return out.filter((g) => {
    const k = `${g.library}|${g.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}


const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export async function loadLibraryGraphic(library: string | undefined, element: string): Promise<MogrtPackage> {
  const matches: { dir: string; lib: string; el: any }[] = [];
  for (const { dir, manifest } of await libraryManifests()) {
    if (library && norm(manifest.name) !== norm(library)) continue;
    for (const el of walkElements(manifest)) {
      if (norm(el.name) === norm(element)) matches.push({ dir, lib: manifest.name, el });
    }
  }
  if (!matches.length) throw new Error(`Graphic '${element}' not found in your Creative Cloud Libraries (use list_library_graphics)`);
  // The same library can be cached twice; any copy will do.
  const { dir, lib, el } = matches[0];
  const comp = (rel: string, type: string) =>
    (el.components ?? []).find((c: any) => c.rel === rel && String(c.type).includes(type)) ??
    (el.components ?? []).find((c: any) => String(c.type).includes(type));
  const defC = comp("alternate", "graphic+json");
  const aegC = comp("primary", "ae.graphic");
  if (!aegC) throw new Error(`'${element}' was made in Premiere, not After Effects; its media can't be replaced this way`);
  const file = async (c: any) => {
    // Components are stored under arbitrary local names, so find the file by
    // its id/path first and otherwise by size + MD5 from the manifest.
    const compDir = join(dir, "components");
    const names = await readdir(compDir);
    const direct = names.find((n) => n.startsWith(c.id)) ?? names.find((n) => n === c.path);
    if (direct) return readFile(join(compDir, direct));
    const ext = extname(c.path ?? "");
    for (const n of names) {
      if (ext && extname(n) !== ext) continue;
      const p = join(compDir, n);
      const st = await stat(p);
      if (c.length !== undefined && st.size !== c.length) continue;
      const data = await readFile(p);
      if (!c.md5 || createHash("md5").update(data).digest("base64") === c.md5) return data;
    }
    throw new Error(`Library file for '${element}' is not downloaded yet; open the Libraries panel once so Creative Cloud syncs it`);
  };
  let definition: any;
  if (defC) {
    try {
      definition = JSON.parse((await file(defC)).toString("utf8"));
    } catch {}
  }
  if (!definition) {
    // Fall back to any definition json whose capsuleName matches.
    const compDir = join(dir, "components");
    for (const n of await readdir(compDir)) {
      if (!n.endsWith(".json")) continue;
      try {
        const j = JSON.parse(await readFile(join(compDir, n), "utf8"));
        if (j.capsuleName === el.name) {
          definition = j;
          break;
        }
      } catch {}
    }
  }
  if (!definition) throw new Error(`Could not read the definition of '${element}'`);
  const thumb = (el.components ?? []).find((c: any) => c.type === "image/png");
  const extras = thumb ? [{ name: "thumb.png", data: await file(thumb).catch(() => Buffer.alloc(0)) }].filter((x) => x.data.length) : [];
  return { definition, aegraphic: await file(aegC), extras, source: `${lib} / ${el.name}` };
}

/* ---------- inspecting ---------- */

export function footageFiles(pkg: MogrtPackage): FootageFile[] {
  const zip = new AdmZip(pkg.aegraphic);
  const out: FootageFile[] = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !IMAGE_EXT.test(e.entryName) || e.entryName.startsWith("Thumbnails/")) continue;
    const size = imageSize(e.getData());
    if (size) out.push({ path: e.entryName, ...size });
  }
  return out;
}

export function mediaSlots(pkg: MogrtPackage): MediaSlot[] {
  const files = footageFiles(pkg);
  const slots: MediaSlot[] = (pkg.definition.clientControls ?? [])
    .filter((c: any) => c.type === 14)
    .map((c: any) => {
      const name = c.uiName?.strDB?.[0]?.str ?? c.id;
      const file = files.find((f) => f.width === c.width && f.height === c.height);
      return { name, width: c.width, height: c.height, file: file?.path };
    });
  for (const s of slots) {
    const others = slots.filter((o) => o !== s && o.file && o.file === s.file).map((o) => o.name);
    if (others.length) s.sharedWith = others;
  }
  return slots;
}

/* ---------- building a variant ---------- */

async function fitImage(src: string, width: number, height: number, ext: string, fit: "cover" | "contain"): Promise<Buffer> {
  if (!existsSync(src)) throw new Error(`Image not found: ${src}`);
  const out = join(tmpdir(), `ppro-mcp-mogrt-${process.pid}-${Date.now()}${ext}`);
  const format = /png/i.test(ext) ? "png" : "jpeg";
  try {
    if (platform() === "darwin") {
      const info = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", src]);
      const w = Number(/pixelWidth: (\d+)/.exec(info.stdout)?.[1]);
      const h = Number(/pixelHeight: (\d+)/.exec(info.stdout)?.[1]);
      if (!w || !h) throw new Error(`Cannot read image ${src}`);
      const scale = fit === "cover" ? Math.max(width / w, height / h) : Math.min(width / w, height / h);
      const rw = Math.max(1, Math.round(w * scale));
      const rh = Math.max(1, Math.round(h * scale));
      await exec("sips", ["-s", "format", format, "-s", "formatOptions", "92", "-z", String(rh), String(rw), src, "--out", out]);
      if (fit === "cover") await exec("sips", ["-c", String(height), String(width), out]);
      else await exec("sips", ["-p", String(height), String(width), "--padColor", "000000", out]);
    } else if (platform() === "win32") {
      const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${src.replace(/'/g, "''")}')
$W = ${width}; $H = ${height}
$s = ${fit === "cover" ? "[Math]::Max" : "[Math]::Min"}($W / $img.Width, $H / $img.Height)
$rw = [int]($img.Width * $s); $rh = [int]($img.Height * $s)
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = 'HighQualityBicubic'
$g.Clear([System.Drawing.Color]::Black)
$g.DrawImage($img, [int](($W - $rw) / 2), [int](($H - $rh) / 2), $rw, $rh)
$bmp.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::${format === "png" ? "Png" : "Jpeg"})
`;
      await exec("powershell", ["-NoProfile", "-Command", ps], { timeout: 60_000 });
    } else {
      throw new Error("Image resizing is supported on macOS and Windows only");
    }
    return await readFile(out);
  } finally {
    unlink(out).catch(() => {});
  }
}

export interface Replacement {
  slot?: string; // Media Replacement name, e.g. "IMG Main"
  file?: string; // or the footage path inside the template
  image: string; // new image on disk
  fit?: "cover" | "contain";
}

export async function buildVariant(pkg: MogrtPackage, replacements: Replacement[], outDir: string, label?: string) {
  const slots = mediaSlots(pkg);
  const files = footageFiles(pkg);
  const swaps = new Map<string, { image: string; fit: "cover" | "contain" }>();
  for (const r of replacements) {
    let target = r.file;
    if (!target && r.slot) {
      const s = slots.find((x) => x.name.trim().toLowerCase() === r.slot!.trim().toLowerCase());
      if (!s) throw new Error(`No media slot '${r.slot}'. Slots: ${slots.map((x) => x.name).join(", ") || "none"}`);
      if (!s.file) throw new Error(`Couldn't match slot '${s.name}' to an image inside the template; pass 'file' instead (see get_mogrt_media)`);
      target = s.file;
    }
    if (!target) throw new Error("Each replacement needs a slot or a file");
    if (!files.find((f) => f.path === target)) throw new Error(`No image '${target}' inside the template`);
    swaps.set(target, { image: r.image, fit: r.fit ?? "cover" });
  }

  const aeg = new AdmZip(pkg.aegraphic);
  for (const [path, { image, fit }] of swaps) {
    const f = files.find((x) => x.path === path)!;
    const data = await fitImage(image, f.width, f.height, extname(path), fit);
    aeg.updateFile(path, data);
  }

  const definition = JSON.parse(JSON.stringify(pkg.definition));
  const baseName = definition.capsuleName ?? "Template";
  const name = `${baseName} - ${label ?? basename(replacements[0].image, extname(replacements[0].image))}`.slice(0, 80);
  definition.capsuleID = randomUUID();
  definition.capsuleName = name;
  definition.capsuleNameLocalized = { strDB: [{ localeString: "en_US", str: name }] };

  const mogrt = new AdmZip();
  mogrt.addFile("definition.json", Buffer.from(JSON.stringify(definition), "utf8"));
  mogrt.addFile("project.aegraphic", aeg.toBuffer());
  for (const x of pkg.extras) if (!x.name.endsWith(".aegraphic") && x.name !== "definition.json") mogrt.addFile(x.name, x.data);
  const safe = name.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "");
  const out = join(outDir, `${safe}_${Date.now()}.mogrt`);
  await writeFile(out, mogrt.toBuffer());
  const affected = slots.filter((s) => s.file && swaps.has(s.file)).map((s) => s.name);
  return { mogrtPath: out, name, replacedSlots: affected };
}

/* ---------- in-place replacement on a placed clip ---------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function mogrtDirs(): Promise<string[]> {
  const dirs: string[] = [join(homedir(), "Documents", "Premiere Connector", "mogrt")];
  const appsRoot = platform() === "darwin" ? "/Applications" : "C:/Program Files/Adobe";
  try {
    for (const n of (await readdir(appsRoot)).filter((n) => n.startsWith("Adobe Premiere Pro"))) {
      dirs.push(platform() === "darwin" ? join(appsRoot, n, `${n}.app`, "Contents", "Essential Graphics") : join(appsRoot, n, "Essential Graphics"));
    }
  } catch {}
  dirs.push(
    platform() === "darwin"
      ? join(homedir(), "Library", "Application Support", "Adobe", "Common", "Motion Graphics Templates")
      : join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Adobe", "Common", "Motion Graphics Templates")
  );
  return dirs;
}

async function* walkFiles(dir: string, test: (n: string) => boolean, depth = 0): AsyncGenerator<string> {
  if (depth > 5) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p, test, depth + 1);
    else if (test(e.name)) yield p;
  }
}

// Find a template's definition.json by its capsuleID.
export async function findDefinition(capsuleId: string, nearFile?: string): Promise<any | null> {
  if (nearFile) {
    const side = join(dirname(nearFile), "definition.json");
    if (existsSync(side)) {
      try {
        const d = JSON.parse(await readFile(side, "utf8"));
        if (d.capsuleID === capsuleId || !d.capsuleID) return d;
      } catch {}
    }
  }
  // Creative Cloud Libraries keep definitions as loose JSON components.
  for (const { dir } of await libraryManifests()) {
    for await (const p of walkFiles(join(dir, "components"), (n) => n.endsWith(".json"))) {
      try {
        const txt = await readFile(p, "utf8");
        if (!txt.includes(capsuleId)) continue;
        const d = JSON.parse(txt);
        if (d.capsuleID === capsuleId) return d;
      } catch {}
    }
  }
  for (const d of await mogrtDirs()) {
    for await (const p of walkFiles(d, (n) => n.endsWith(".mogrt"))) {
      try {
        const entry = new AdmZip(p).getEntry("definition.json");
        if (!entry) continue;
        const def = JSON.parse(entry.getData().toString("utf8"));
        if (def.capsuleID === capsuleId) return def;
      } catch {}
    }
  }
  return null;
}

// Rebuild a placed clip's .aegraphic with new images. The result is written to
// ~/Documents/Premiere Connector/mogrt/<capsuleID>/ next to its definition so it
// can be found (and replaced again) later.
export async function buildAegraphicVariant(aegraphicPath: string, capsuleId: string, replacements: Replacement[]) {
  const aegraphic = await readFile(aegraphicPath);
  const definition = (await findDefinition(capsuleId, aegraphicPath)) ?? { capsuleID: capsuleId, clientControls: [] };
  const pkg: MogrtPackage = { definition, aegraphic, extras: [], source: aegraphicPath };
  const slots = mediaSlots(pkg);
  const files = footageFiles(pkg);
  const aeg = new AdmZip(aegraphic);
  const replaced: string[] = [];
  for (const r of replacements) {
    let target = r.file;
    if (!target && r.slot) {
      const s = slots.find((x) => x.name.trim().toLowerCase() === r.slot!.trim().toLowerCase());
      if (!s) {
        throw new Error(
          slots.length
            ? `No media slot '${r.slot}'. Slots: ${slots.map((x) => x.name).join(", ")}`
            : `The template definition wasn't found, so slots can't be named. Pass 'file' instead; images inside: ${files.map((f) => `${f.path} (${f.width}x${f.height})`).join(", ")}`
        );
      }
      if (!s.file) throw new Error(`Couldn't match slot '${s.name}' to an image inside the template; pass 'file' instead`);
      target = s.file;
    }
    const f = files.find((x) => x.path === target);
    if (!f) throw new Error(`No image '${target}' inside the template. Images: ${files.map((x) => x.path).join(", ")}`);
    aeg.updateFile(f.path, await fitImage(r.image, f.width, f.height, extname(f.path), r.fit ?? "cover"));
    for (const s of slots) if (s.file === f.path && !replaced.includes(s.name)) replaced.push(s.name);
    if (!slots.length) replaced.push(f.path);
  }
  const dir = join(homedir(), "Documents", "Premiere Connector", "mogrt", capsuleId);
  await mkdir(dir, { recursive: true });
  if (definition.clientControls?.length) await writeFile(join(dir, "definition.json"), JSON.stringify(definition));
  const out = join(dir, `${basename(aegraphicPath, ".aegraphic").replace(/_\d{13}$/, "")}_${Date.now()}.aegraphic`);
  await writeFile(out, aeg.toBuffer());
  return { aegraphicPath: out, replacedSlots: replaced, slots };
}

export function capsuleIdFromPath(p: string): string | null {
  const parent = basename(dirname(p));
  return UUID.test(parent) ? parent : null;
}

// Package a .aegraphic and definition as a new standalone .mogrt (new capsuleID).
export async function packageMogrt(definition: any, aegraphicPath: string, label: string): Promise<string> {
  const def = JSON.parse(JSON.stringify(definition));
  const name = `${def.capsuleName ?? "Template"} - ${label}`.slice(0, 80);
  def.capsuleID = randomUUID();
  def.capsuleName = name;
  def.capsuleNameLocalized = { strDB: [{ localeString: "en_US", str: name }] };
  const z = new AdmZip();
  z.addFile("definition.json", Buffer.from(JSON.stringify(def), "utf8"));
  z.addFile("project.aegraphic", await readFile(aegraphicPath));
  const dir = join(homedir(), "Documents", "Premiere Connector", "mogrt");
  await mkdir(dir, { recursive: true });
  const out = join(dir, `${name.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "")}_${Date.now()}.mogrt`);
  await writeFile(out, z.toBuffer());
  return out;
}
