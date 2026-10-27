/* Motion Graphics templates (.mogrt) and still placement.
   Text in Premiere's own titles can't be edited by script; After Effects
   based .mogrts expose their text and colors through the MGT component. */

function _placedClipAt(trackIndex, startSec) {
  var idx = _clipIndexAt("video", trackIndex, startSec);
  if (idx < 0) _fail("The graphic was not placed (is video track " + trackIndex + " locked?)");
  return { clip: _getClip("video", trackIndex, idx), index: idx };
}

function _setDuration(clip, startSec, durationSec) {
  if (_has(durationSec) && durationSec > 0) clip.end = _makeTime(startSec + durationSec);
}

function importMogrt(mogrtPath, trackIndex, startSec, durationSec, audioTrackIndex) {
  var seq = _seq();
  if (!new File(mogrtPath).exists) _fail("MOGRT not found: " + mogrtPath);
  _getTrack("video", trackIndex);
  var item = seq.importMGT(mogrtPath, _secondsToTicks(startSec), trackIndex, _has(audioTrackIndex) ? audioTrackIndex : 0);
  if (!item) _fail("Premiere could not import the MOGRT");
  var placed = _placedClipAt(trackIndex, startSec);
  _setDuration(placed.clip, startSec, durationSec);
  var info = _clipInfo(placed.clip, "video", trackIndex, placed.index);
  info.properties = _mogrtProps(placed.clip);
  return info;
}

// Place a graphic straight from a Creative Cloud Library.
function importLibraryGraphic(libraryName, graphicName, trackIndex, startSec, durationSec) {
  var seq = _seq();
  _getTrack("video", trackIndex);
  var item = seq.importMGTFromLibrary(libraryName, graphicName, _secondsToTicks(startSec), trackIndex, 0);
  if (!item) _fail("Premiere could not place '" + graphicName + "' from library '" + libraryName + "'");
  var placed = _placedClipAt(trackIndex, startSec);
  _setDuration(placed.clip, startSec, durationSec);
  var info = _clipInfo(placed.clip, "video", trackIndex, placed.index);
  info.properties = _mogrtProps(placed.clip);
  return info;
}

function _mgt(clip) {
  var m = null;
  try { m = clip.getMGTComponent(); } catch (ex) {}
  return m;
}

function _isTextParam(v) {
  return typeof v === "string" && v.indexOf("textEditValue") >= 0;
}

function _mogrtProps(clip) {
  var m = _mgt(clip);
  var out = [];
  if (!m) return out;
  for (var i = 0; i < m.properties.numItems; i++) {
    var p = m.properties[i];
    if (!p.displayName) continue;
    var raw;
    try { raw = p.getValue(); } catch (ex) { continue; }
    var info = { index: i, name: p.displayName };
    if (_isTextParam(raw)) {
      var o = JSON.parse(raw);
      info.type = "text";
      info.value = o.textEditValue;
      if (o.fontEditValue) info.font = o.fontEditValue[0];
      if (o.fontSizeEditValue) info.fontSize = o.fontSizeEditValue[0];
    } else {
      var color = null;
      try { color = p.getColorValue(); } catch (ex) {}
      if (color && color.length === 4 && typeof raw === "number" && raw > 1e9) {
        info.type = "color";
        info.value = _rgbToHex(color[1], color[2], color[3]);
      } else if (/^0{8}-0{4}-0{4}-0{4}-0{12}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(raw))) {
        info.type = "media";
        info.note = "Media slot: change it with replace_mogrt_media";
      } else if (/^([0-9a-f-]{36};)+$/i.test(String(raw))) {
        continue; // group header
      } else {
        info.value = _plainValue(raw);
      }
    }
    out.push(info);
  }
  return out;
}

function _rgbToHex(r, g, b) {
  function h(n) { var s = Math.round(n).toString(16); return s.length < 2 ? "0" + s : s; }
  return "#" + h(r) + h(g) + h(b);
}

function getMogrtProperties(trackIndex, clipIndex) {
  var clip = _getClip("video", trackIndex, clipIndex);
  if (!_mgt(clip)) {
    var nativeText = _findComponent(clip, "Text");
    _fail(nativeText ? "This is a Premiere title; its text can't be read or changed by script. Use an After Effects .mogrt or add_text." : "This clip is not a Motion Graphics template");
  }
  return _mogrtProps(clip);
}

// value: text for text params, "#rrggbb" for colors, number/bool otherwise.
function setMogrtProperty(trackIndex, clipIndex, propertyName, value, fontSize) {
  var clip = _getClip("video", trackIndex, clipIndex);
  var m = _mgt(clip);
  if (!m) _fail("This clip is not an After Effects Motion Graphics template");
  var prop = _getProperty(m, propertyName);
  var raw = prop.getValue();
  if (_isTextParam(raw)) {
    var o = JSON.parse(raw);
    o.textEditValue = String(value);
    if (_has(fontSize) && fontSize > 0 && o.fontSizeEditValue) {
      for (var i = 0; i < o.fontSizeEditValue.length; i++) o.fontSizeEditValue[i] = fontSize;
    }
    if (o.fontTextRunLength) o.fontTextRunLength = [String(value).length];
    prop.setValue(JSON.stringify(o), true);
  } else if (typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value)) {
    var hex = value.replace("#", "");
    prop.setColorValue(255, parseInt(hex.substr(0, 2), 16), parseInt(hex.substr(2, 2), 16), parseInt(hex.substr(4, 2), 16), true);
  } else {
    prop.setValue(value, true);
  }
  return { properties: _mogrtProps(clip) };
}

// Put a project item (e.g. a rendered text PNG) on a video track for a duration.
function placeStill(nodeId, trackIndex, startSec, durationSec) {
  var item = _getItem(nodeId);
  var track = _getTrack("video", trackIndex);
  if (track.isLocked()) _fail("Video track " + trackIndex + " is locked");
  track.overwriteClip(item, _secondsToTicks(startSec));
  var placed = _placedClipAt(trackIndex, startSec);
  _setDuration(placed.clip, startSec, durationSec);
  return _clipInfo(placed.clip, "video", trackIndex, placed.index);
}

// First empty-at-that-range video track at or above minTrack (adds one if needed).
function findFreeVideoTrack(startSec, endSec, minTrack) {
  var seq = _seq();
  for (var t = minTrack || 0; t < seq.videoTracks.numTracks; t++) {
    var track = seq.videoTracks[t];
    if (track.isLocked()) continue;
    var free = true;
    for (var c = 0; c < track.clips.numItems; c++) {
      var s = _sec(track.clips[c].start), e = _sec(track.clips[c].end);
      if (s < endSec - 1e-6 && e > startSec + 1e-6) { free = false; break; }
    }
    if (free) return { trackIndex: t };
  }
  _qeSeq().addTracks(1, seq.videoTracks.numTracks, 0, 1, seq.audioTracks.numTracks, 0, 0, 0);
  return { trackIndex: seq.videoTracks.numTracks - 1, added: true };
}

/* ---------- media replacement on a placed template ---------- */

var _ZERO_GUID = "00000000-0000-0000-0000-000000000000";
var _GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function _projectItemUsage(nodeId) {
  var n = 0;
  var seqs = app.project.sequences;
  for (var i = 0; i < seqs.numSequences; i++) {
    _forEachClip(seqs[i], function (clip) {
      try { if (clip.projectItem && clip.projectItem.nodeId === nodeId) n++; } catch (ex) {}
    });
  }
  return n;
}

// Where a template clip's After Effects data lives, and how many clips share it.
function getMogrtClipSource(trackIndex, clipIndex) {
  var clip = _getClip("video", trackIndex, clipIndex);
  var m = _mgt(clip);
  if (!m) _fail("This clip is not an After Effects Motion Graphics template");
  var item = clip.projectItem;
  var path = item.getMediaPath();
  if (!/\.aegraphic$/i.test(path)) _fail("This template was made in Premiere; its media can't be replaced");
  var slots = [];
  for (var i = 0; i < m.properties.numItems; i++) {
    var v;
    try { v = String(m.properties[i].getValue()); } catch (ex) { continue; }
    if (_GUID_RE.test(v)) slots.push({ index: i, name: m.properties[i].displayName, overridden: v !== _ZERO_GUID });
  }
  return { nodeId: item.nodeId, name: clip.name, aegraphicPath: path, usage: _projectItemUsage(item.nodeId), mediaSlots: slots };
}

// Show the template's (new) default image in the named slots by clearing any
// media dropped onto them in the Essential Graphics panel.
function _resetSlots(clip, slotNames) {
  var m = _mgt(clip);
  for (var i = 0; i < m.properties.numItems; i++) {
    var p = m.properties[i];
    var v;
    try { v = String(p.getValue()); } catch (ex) { continue; }
    if (!_GUID_RE.test(v) || v === _ZERO_GUID) continue;
    for (var s = 0; s < slotNames.length; s++) {
      if (_norm(slotNames[s]) === _norm(p.displayName)) p.setValue(_ZERO_GUID, true);
    }
  }
}

// In place: point the template's project item at the rebuilt .aegraphic.
function relinkMogrtClip(trackIndex, clipIndex, aegraphicPath, slotNames) {
  var clip = _getClip("video", trackIndex, clipIndex);
  var item = clip.projectItem;
  if (!new File(aegraphicPath).exists) _fail("File not found: " + aegraphicPath);
  if (!item.changeMediaPath(aegraphicPath, true)) _fail("Premiere refused to relink the template");
  _resetSlots(clip, slotNames || []);
  var info = _clipInfo(clip, "video", trackIndex, clipIndex);
  info.properties = _mogrtProps(clip);
  return info;
}

function _snapshotValues(comp) {
  var out = [];
  for (var i = 0; i < comp.properties.numItems; i++) {
    var p = comp.properties[i];
    var rec = { index: i, name: p.displayName };
    try { rec.animated = p.isTimeVarying(); } catch (ex) { rec.animated = false; }
    try { rec.value = p.getValue(); } catch (ex) { continue; }
    try { var c = p.getColorValue(); if (c && c.length === 4) rec.color = c; } catch (ex) {}
    out.push(rec);
  }
  return out;
}

function _restoreValues(comp, snap) {
  for (var i = 0; i < snap.length; i++) {
    var rec = snap[i];
    if (rec.animated || rec.index >= comp.properties.numItems) continue;
    var p = comp.properties[rec.index];
    if (p.displayName !== rec.name) continue;
    var v = String(rec.value);
    if (_GUID_RE.test(v) || /^([0-9a-f-]{36};)+$/i.test(v)) continue;
    try {
      if (rec.color && typeof rec.value === "number" && rec.value > 1e9) p.setColorValue(rec.color[0], rec.color[1], rec.color[2], rec.color[3], true);
      else p.setValue(rec.value, true);
    } catch (ex) {}
  }
}

// Fallback when other clips share the template: place the rebuilt copy where
// the clip is, carry over its settings, and remove the original.
function swapMogrtClip(trackIndex, clipIndex, mogrtPath) {
  var seq = _seq();
  var old = _getClip("video", trackIndex, clipIndex);
  var start = _sec(old.start), end = _sec(old.end);
  var mgtSnap = _snapshotValues(_mgt(old));
  var stdSnap = {};
  var names = ["Motion", "Opacity"];
  for (var n = 0; n < names.length; n++) {
    var c = _findComponent(old, names[n]);
    if (c) stdSnap[names[n]] = _snapshotValues(c);
  }
  var wasDisabled = old.disabled;

  // Build on a temporary top track so nothing else on the timeline is touched.
  _qeSeq().addTracks(1, seq.videoTracks.numTracks, 0, 1, seq.audioTracks.numTracks, 0, 0, 0);
  var temp = seq.videoTracks.numTracks - 1;
  seq.importMGT(mogrtPath, _secondsToTicks(start), temp, 0);
  var idx = _clipIndexAt("video", temp, start);
  if (idx < 0) _fail("Could not place the rebuilt template");
  var fresh = _getClip("video", temp, idx);
  fresh.end = _makeTime(end);
  _restoreValues(_mgt(fresh), mgtSnap);
  for (var k in stdSnap) {
    var fc = _findComponent(fresh, k);
    if (fc) _restoreValues(fc, stdSnap[k]);
  }
  fresh.disabled = wasDisabled;

  old.remove(false, true);
  var q = _qeSeq().getVideoTrackAt(temp);
  for (var i = 0; i < q.numItems; i++) {
    var it = q.getItemAt(i);
    if (it.type !== "Empty") { it.moveToTrack(trackIndex - temp, 0, "0", false); break; }
  }
  if (seq.videoTracks[temp].clips.numItems === 0) _qeSeq().removeVideoTrack(temp);
  var newIdx = _clipIndexAt("video", trackIndex, start);
  var info = _clipInfo(_getClip("video", trackIndex, newIdx), "video", trackIndex, newIdx);
  info.properties = _mogrtProps(_getClip("video", trackIndex, newIdx));
  var animated = [];
  for (var s = 0; s < mgtSnap.length; s++) if (mgtSnap[s].animated) animated.push(mgtSnap[s].name);
  for (var k2 in stdSnap) for (var s2 = 0; s2 < stdSnap[k2].length; s2++) if (stdSnap[k2][s2].animated) animated.push(k2 + "/" + stdSnap[k2][s2].name);
  if (animated.length) info.note = "Keyframed properties were not copied: " + animated.join(", ");
  return info;
}
