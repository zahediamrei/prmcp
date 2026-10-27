// Renders styled text to a transparent PNG the size of the sequence frame.
// Uses the OS text engine (CoreText on macOS, GDI+ on Windows), so right-to-left
// complex and right-to-left scripts are shaped correctly and any installed font works.
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import { tmpdir, platform } from "os";
import { join } from "path";

const exec = promisify(execFile);

export interface TextSpec {
  text: string;
  width: number;
  height: number;
  font?: string;
  fontSize: number;
  color: string; // #rrggbb
  strokeColor?: string;
  strokeWidth?: number; // px
  backgroundColor?: string; // box behind the text
  backgroundOpacity?: number; // 0-1
  padding?: number; // px around text inside the box
  align: "left" | "center" | "right";
  x: number; // 0-1, horizontal center of the text block
  y: number; // 0-1, vertical center of the text block
  maxWidth: number; // 0-1 of frame width
  shadow?: boolean;
  out: string;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`Invalid color '${hex}', use #rrggbb`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const MAC_SCRIPT = String.raw`
ObjC.import('Cocoa');
function color(c, a) { return $.NSColor.colorWithSRGBRedGreenBlueAlpha(c[0] / 255, c[1] / 255, c[2] / 255, a === undefined ? 1 : a); }
function run(argv) {
  var s = JSON.parse(argv[0]);
  var W = s.width, H = s.height;
  var rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, W, H, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  rep.size = $.NSMakeSize(W, H);
  var ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(ctx);
  var font = s.font ? $.NSFont.fontWithNameSize(s.font, s.fontSize) : null;
  if (!font || font.isNil()) {
    font = s.font ? $.NSFontManager.sharedFontManager.fontWithFamilyTraitsWeightSize(s.font, 0, 5, s.fontSize) : null;
  }
  if (!font || font.isNil()) font = $.NSFont.boldSystemFontOfSize(s.fontSize);
  var para = $.NSMutableParagraphStyle.alloc.init;
  para.alignment = { left: 0, center: 1, right: 2 }[s.align];
  para.baseWritingDirection = -1;
  var attrs = $.NSMutableDictionary.alloc.init;
  attrs.setObjectForKey(font, $.NSFontAttributeName);
  attrs.setObjectForKey(para, $.NSParagraphStyleAttributeName);
  var str = $(s.text);
  var maxW = W * s.maxWidth;
  var b = str.boundingRectWithSizeOptionsAttributes($.NSMakeSize(maxW, H), 1 | 2, attrs);
  var tw = Math.ceil(b.size.width), th = Math.ceil(b.size.height);
  var cx = W * s.x, cy = H * (1 - s.y);
  var rect = $.NSMakeRect(cx - maxW / 2, cy - th / 2, maxW, th);
  if (s.align === 'left') rect = $.NSMakeRect(cx - tw / 2, cy - th / 2, maxW, th);
  if (s.align === 'right') rect = $.NSMakeRect(cx + tw / 2 - maxW, cy - th / 2, maxW, th);
  if (s.background) {
    var p = s.padding;
    var bx = s.align === 'center' ? cx - tw / 2 : (s.align === 'left' ? cx - tw / 2 : cx - tw / 2);
    var box = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(bx - p, cy - th / 2 - p * 0.6, tw + 2 * p, th + p * 1.2), p * 0.6, p * 0.6);
    color(s.background, s.backgroundOpacity).setFill;
    box.fill;
  }
  if (s.shadow) {
    var sh = $.NSShadow.alloc.init;
    sh.shadowOffset = $.NSMakeSize(0, -s.fontSize * 0.05);
    sh.shadowBlurRadius = s.fontSize * 0.12;
    sh.shadowColor = color([0, 0, 0], 0.75);
    attrs.setObjectForKey(sh, $.NSShadowAttributeName);
  }
  if (s.stroke && s.strokeWidth > 0) {
    var sa = attrs.mutableCopy;
    sa.setObjectForKey(color(s.stroke), $.NSForegroundColorAttributeName);
    sa.setObjectForKey(color(s.stroke), $.NSStrokeColorAttributeName);
    sa.setObjectForKey($.NSNumber.numberWithDouble(s.strokeWidth * 2 / s.fontSize * 100), $.NSStrokeWidthAttributeName);
    str.drawWithRectOptionsAttributes(rect, 1 | 2, sa);
    attrs.removeObjectForKey($.NSShadowAttributeName);
  }
  attrs.setObjectForKey(color(s.color), $.NSForegroundColorAttributeName);
  str.drawWithRectOptionsAttributes(rect, 1 | 2, attrs);
  $.NSGraphicsContext.restoreGraphicsState;
  var data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  if (!data.writeToFileAtomically(s.out, true)) throw new Error('could not write ' + s.out);
  return 'ok';
}
`;

const WIN_SCRIPT = String.raw`
param([string]$specPath)
Add-Type -AssemblyName System.Drawing
$s = Get-Content -Raw -Encoding UTF8 $specPath | ConvertFrom-Json
$bmp = New-Object System.Drawing.Bitmap $s.width, $s.height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
$family = if ($s.font) { $s.font } else { 'Segoe UI' }
$font = New-Object System.Drawing.Font $family, ([float]$s.fontSize), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = @{ left = 'Near'; center = 'Center'; right = 'Far' }[$s.align]
if ($s.text -match '[\u0590-\u08FF]') { $fmt.FormatFlags = 'DirectionRightToLeft'; if ($s.align -ne 'center') { $fmt.Alignment = @{ left = 'Far'; right = 'Near' }[$s.align] } }
$maxW = $s.width * $s.maxWidth
$size = $g.MeasureString($s.text, $font, [int]$maxW, $fmt)
$cx = $s.width * $s.x; $cy = $s.height * $s.y
$rect = New-Object System.Drawing.RectangleF ([float]($cx - $maxW / 2)), ([float]($cy - $size.Height / 2)), ([float]$maxW), ([float]$size.Height)
function Col($c, $a) { [System.Drawing.Color]::FromArgb([int](255 * $a), $c[0], $c[1], $c[2]) }
if ($s.background) {
  $p = $s.padding
  $brush = New-Object System.Drawing.SolidBrush (Col $s.background $s.backgroundOpacity)
  $g.FillRectangle($brush, [float]($cx - $size.Width / 2 - $p), [float]($cy - $size.Height / 2 - $p * 0.6), [float]($size.Width + 2 * $p), [float]($size.Height + $p * 1.2))
}
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddString($s.text, $font.FontFamily, [int]$font.Style, [float]$s.fontSize, $rect, $fmt)
if ($s.shadow) {
  $m = New-Object System.Drawing.Drawing2D.Matrix; $m.Translate([float]($s.fontSize * 0.04), [float]($s.fontSize * 0.05))
  $sp = $path.Clone(); $sp.Transform($m)
  $g.FillPath((New-Object System.Drawing.SolidBrush (Col @(0,0,0) 0.6)), $sp)
}
if ($s.stroke -and $s.strokeWidth -gt 0) {
  $pen = New-Object System.Drawing.Pen (Col $s.stroke 1), ([float]($s.strokeWidth * 2)); $pen.LineJoin = 'Round'
  $g.DrawPath($pen, $path)
}
$g.FillPath((New-Object System.Drawing.SolidBrush (Col $s.color 1)), $path)
$bmp.Save($s.out, [System.Drawing.Imaging.ImageFormat]::Png)
'ok'
`;

export async function renderText(spec: TextSpec): Promise<string> {
  const payload = {
    ...spec,
    color: rgb(spec.color),
    stroke: spec.strokeColor ? rgb(spec.strokeColor) : null,
    background: spec.backgroundColor ? rgb(spec.backgroundColor) : null,
    backgroundOpacity: spec.backgroundOpacity ?? 0.6,
    padding: spec.padding ?? Math.round(spec.fontSize * 0.35),
  };
  const stamp = `${process.pid}-${Date.now()}`;
  if (platform() === "darwin") {
    const script = join(tmpdir(), `ppro-mcp-text-${stamp}.js`);
    await writeFile(script, MAC_SCRIPT, "utf8");
    try {
      await exec("osascript", ["-l", "JavaScript", script, JSON.stringify(payload)], { timeout: 30_000 });
    } finally {
      unlink(script).catch(() => {});
    }
  } else if (platform() === "win32") {
    const script = join(tmpdir(), `ppro-mcp-text-${stamp}.ps1`);
    const specPath = join(tmpdir(), `ppro-mcp-text-${stamp}.json`);
    await writeFile(script, "\uFEFF" + WIN_SCRIPT, "utf8");
    await writeFile(specPath, JSON.stringify(payload), "utf8");
    try {
      await exec("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, specPath], { timeout: 30_000 });
    } finally {
      unlink(script).catch(() => {});
      unlink(specPath).catch(() => {});
    }
  } else {
    throw new Error("Text rendering is supported on macOS and Windows only");
  }
  return spec.out;
}
