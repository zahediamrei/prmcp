---
name: premiere-connector
description: "How to edit in Adobe Premiere Pro with the Premiere Connector tools: the order to work in, and rules learned from real projects (clip duration, MOGRT instances, media slots, zero-width characters, audio in slots). Use whenever a task touches a Premiere Pro project."
---

# Premiere Pro with Premiere Connector

Read this before touching a Premiere project. The tools come from the `premiere-connector` MCP server; Premiere Pro must be
open with **Window > Extensions > Premiere Connector**.

## Start here

1. `get_status`, then `get_active_sequence` and `get_timeline_clips`. Know the edit before changing it.
2. Clips are addressed by track type, track index and clip index, all 0-based. Indexes change after every cut, move or
   delete: read the timeline again before the next edit instead of guessing.
3. After a visual change, look at it with `export_frame`.
4. Something went wrong: `undo`.
5. When a tool can't do something, `execute_extendscript` runs ExtendScript directly. The rules below
   say where the obvious approach breaks.

Each section below is a rule learned from a real problem. Add new ones at the end. Only general Premiere rules belong
here; a project's own setup goes in that project's skill.

## 1. Changing clip duration (MOGRTs and all clips)

**Never set only `trackItem.end`.** Doing so leaves `outPoint` unchanged, so Premiere thinks the clip already reaches the end of its media and the user can no longer extend it by hand. This breaks responsive MOGRTs (e.g. a 60s template shortened to 10s can't be dragged back out).

Always change source Out and timeline End together:

```javascript
// newDur in seconds
var o = new Time(); o.seconds = clip.inPoint.seconds + newDur; clip.outPoint = o;
var e = new Time(); e.seconds = clip.start.seconds + newDur; clip.end = e;
```

Order: set `outPoint` first, then `end`. After the edit, read back and confirm `end - start == outPoint - inPoint`.

Do not change a MOGRT's speed to fit a length, and never set In/Out on the project item (`projectItem.setOutPoint`) - that limits every instance.

## 2. Repairing clips already broken by rule 1

If the user says MOGRTs can't be extended, run this on the active sequence (tell the user first, save afterwards):

```javascript
var s = app.project.activeSequence, fixed = [];
for (var t = 0; t < s.videoTracks.numTracks; t++) {
  var tr = s.videoTracks[t];
  for (var i = 0; i < tr.clips.numItems; i++) {
    var c = tr.clips[i];
    var dur = c.end.seconds - c.start.seconds;
    var src = c.outPoint.seconds - c.inPoint.seconds;
    if (Math.abs(dur - src) > 0.001 && c.getSpeed() == 1) {
      var o = new Time(); o.seconds = c.inPoint.seconds + dur; c.outPoint = o;
      var e = new Time(); e.seconds = c.start.seconds + dur; c.end = e;
      fixed.push(c.name + ' (V' + (t+1) + ')');
    }
  }
}
fixed;
```

Report which clips were fixed.

## 3. One project item per MOGRT — never duplicate template files

Symptom: projects get heavy and slow to open, with dozens of copies of the same .aegraphic in the "Motion Graphics Template Media" bin.
Cause: importing the template from the Library (`import_library_graphic`) for every placement, and `replace_mogrt_media` (which bakes the image into a new .aegraphic copy per clip).

Correct method:
- Never import MOGRTs from the Creative Cloud Library into a project that already has them. Only when the user explicitly asks to update a template from the library.
- Place new instances from the existing project item in the "Motion Graphics Template Media" bin: `track.overwriteClip(projectItem, startSeconds)` (or insertClip), then trim with rule 1 and set text/menu values with `getMGTComponent().properties.getParamForDisplayName(name).setValue(v, true)`.
- Text values are JSON strings: change only `textEditValue` (and `fontTextRunLength` to the new length).
- Do NOT use `replace_mogrt_media` for images/footage. Fill media slots through the UI (rule 5) using computer use. If computer use isn't available, leave the slot and tell the user which clip/slot needs which file.
- After work, check the bin: one item per template name. Delete unused duplicates (only after confirming no timeline clip uses them).

## 4. Zero-width characters in template text (ZWNJ, ZWJ)

Symptom: in languages that use zero-width non-joiners or joiners (many Arabic-script and Indic scripts), words come out joined wrongly. The U+200C / U+200D character is stripped when ExtendScript source is sent through the bridge (both the raw character and sometimes the `\u200C` escape).
Correct method: build it at runtime: `var Z = String.fromCharCode(0x200C);` and concatenate (`part1 + Z + part2`). Read back and count `text.split(Z).length - 1`.

## 5. Filling MOGRT media slots (Premiere 2026)

Premiere 2026 has no Essential Graphics panel; MOGRT controls are in the **Properties** panel. Dragging a project item onto the slot does not work (a fast drag inserts the clip at the end of the timeline instead — undo it).
Correct method:
- Select the MOGRT clip (ExtendScript `clip.setSelected(true,true)` after deselecting all works; the Properties panel follows).
- In Properties, hover the media row (e.g. `Footage`, `Profile Image.png`), click its ≡ menu at the right → **Replace from Finder…** → pick the file. The file is also imported into the project.
- In the macOS file dialog, Go to Folder (cmd+shift+g) fails with non-ASCII paths typed by computer use. Copy the needed files to an ASCII path first (e.g. `~/Downloads/<slots>/`) with short names, or click through the sidebar. Tell the user those files are now referenced from that folder.
- ExtendScript `getValue()` of a filled media slot still returns `00000000-…`; verify by moving the playhead and looking at the Program monitor instead.
- Check portrait framing in circular slots: use a square crop centred on the face.
- Computer use needs Screen Recording for Claude; if screenshots fail right after it was enabled, Claude must be restarted.

## 6. Audio of clips used inside MOGRT media slots

Symptom: footage placed in a MOGRT slot plays silent.
Correct method: put the same clip's audio on its own audio track at the slot's start, trimmed to the slot length (rule 1).
- `audioTrack.overwriteClip(item, t)` does NOT place audio only — it drops the video on V1 and overwrites the background. Never use it for this.
- Instead: overwrite onto the topmost, empty video track (`q.videoTracks[q.videoTracks.numTracks-1]`) at the slot start → its linked audio lands on a free audio track → trim the audio with rule 1 → remove the video item on that top track (`clip.remove(false,false)`, it leaves the audio). Check first that nothing on that top track is overwritten (a long clip can run over the Cover after 60s).
- Check the clip has audio (`ffprobe`) and skip music-only audio. List afterwards all V/A clips to confirm nothing else moved; undo with Edit > Undo if it did.

## Adding rules

When a new Premiere problem is found and solved, add it here as a numbered section: the symptom, the cause, and the correct method.