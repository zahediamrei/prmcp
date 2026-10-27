/* Shared utilities for Premiere Connector ExtendScript.
   Tool functions take plain arguments, return a plain object (or array) and
   throw an Error with a readable message on failure; __mcpDispatch turns both
   into JSON for the MCP server. Times are always in seconds. */

var TICKS_PER_SECOND = 254016000000;

function _errorText(ex) {
  var msg = (ex && ex.message) ? ex.message : String(ex);
  if (ex && ex.line && !ex.mcp) msg += " (line " + ex.line + ")";
  return msg;
}

function _ok(data) {
  if (data === undefined || data === null) data = {};
  data.success = true;
  return JSON.stringify(data);
}

function _err(msg) {
  return JSON.stringify({ error: msg });
}

// Entry point for every MCP tool call.
function __mcpDispatch(name, argsJson) {
  try {
    var fn = $.global[name];
    if (typeof fn !== "function") return _err("Unknown function: " + name);
    var result = fn.apply(null, JSON.parse(argsJson));
    if (result === undefined || result === null) return _ok();
    if (typeof result === "string") return result;
    if (!(result instanceof Array) && result.success === undefined && result.error === undefined) result.success = true;
    return JSON.stringify(result);
  } catch (ex) {
    return _err(_errorText(ex));
  }
}

// Runs raw ExtendScript for execute_extendscript; returns the last expression.
function __mcpEval(code) {
  try {
    var result = eval(code);
    if (result === undefined) return _ok();
    if (typeof result === "string") return result;
    return JSON.stringify(result);
  } catch (ex) {
    return _err(_errorText(ex));
  }
}

// Expected failures: the message is meant for the user, so no line number.
function _fail(msg) {
  var e = new Error(msg);
  e.mcp = true;
  throw e;
}

function _qe() {
  app.enableQE();
  return qe;
}

/* ---------- time ---------- */

function _secondsToTicks(seconds) {
  return String(Math.round(Number(seconds) * TICKS_PER_SECOND));
}

function _ticksToSeconds(ticks) {
  return Number(ticks) / TICKS_PER_SECOND;
}

// Accepts a Time object or a ticks string/number and returns seconds.
function _sec(t) {
  if (t === undefined || t === null) return null;
  if (typeof t === "object" && t.ticks !== undefined) return _ticksToSeconds(t.ticks);
  return _ticksToSeconds(t);
}

function _makeTime(seconds) {
  var t = new Time();
  t.ticks = _secondsToTicks(seconds);
  return t;
}

function _round(n) {
  return Math.round(n * 10000) / 10000;
}

function _has(v) {
  return v !== undefined && v !== null;
}

/* ---------- project / sequence ---------- */

function _project() {
  if (!app.project) _fail("No project is open in Premiere Pro");
  return app.project;
}

function _seq() {
  var seq = _project().activeSequence;
  if (!seq) _fail("No active sequence. Open a sequence in the timeline first (set_active_sequence).");
  return seq;
}

function _qeSeq() {
  _seq();
  var q = _qe().project.getActiveSequence();
  if (!q) _fail("No active sequence");
  return q;
}

function _frameDuration(seq) {
  return _ticksToSeconds(seq.timebase);
}

function _seqEnd(seq) {
  return _sec(seq.end);
}

function _findSequence(nameOrId) {
  var seqs = _project().sequences;
  for (var i = 0; i < seqs.numSequences; i++) {
    if (seqs[i].sequenceID === nameOrId || seqs[i].name === nameOrId) return seqs[i];
  }
  return null;
}

/* ---------- tracks and clips ---------- */

function _tracks(seq, trackType) {
  if (trackType === "video") return seq.videoTracks;
  if (trackType === "audio") return seq.audioTracks;
  _fail("trackType must be 'video' or 'audio'");
}

function _getTrack(trackType, trackIndex) {
  var tracks = _tracks(_seq(), trackType);
  if (trackIndex < 0 || trackIndex >= tracks.numTracks) {
    _fail(trackType + " track " + trackIndex + " does not exist (sequence has " + tracks.numTracks + " " + trackType + " tracks, 0-based)");
  }
  return tracks[trackIndex];
}

function _getClip(trackType, trackIndex, clipIndex) {
  var track = _getTrack(trackType, trackIndex);
  if (clipIndex < 0 || clipIndex >= track.clips.numItems) {
    _fail("Clip " + clipIndex + " not found on " + trackType + " track " + trackIndex + " (track has " + track.clips.numItems + " clips, 0-based)");
  }
  return track.clips[clipIndex];
}

function _qeTrack(trackType, trackIndex) {
  _getTrack(trackType, trackIndex);
  var q = _qeSeq();
  return trackType === "video" ? q.getVideoTrackAt(trackIndex) : q.getAudioTrackAt(trackIndex);
}

// QE track items include gaps ("Empty"), so map a DOM clip to its QE twin by
// matching the start time.
function _qeClip(trackType, trackIndex, clipIndex) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var qTrack = _qeTrack(trackType, trackIndex);
  var startTicks = String(clip.start.ticks);
  for (var i = 0; i < qTrack.numItems; i++) {
    var item = qTrack.getItemAt(i);
    if (item && item.type !== "Empty" && String(item.start.ticks) === startTicks) return item;
  }
  _fail("Could not locate the clip in the QE timeline");
}

function _linkedItems(clip) {
  var out = [];
  try {
    var linked = clip.getLinkedItems();
    if (linked) {
      for (var i = 0; i < linked.numItems; i++) {
        if (linked[i]) out.push(linked[i]);
      }
    }
  } catch (ex) {}
  if (out.length === 0) out.push(clip);
  return out;
}

function _clipInfo(clip, trackType, trackIndex, clipIndex) {
  var speed = 1;
  try { speed = clip.getSpeed() || 1; } catch (ex) {}
  // The DOM reports the in point divided by the clip speed.
  var inPoint = _sec(clip.inPoint) * speed;
  var duration = _sec(clip.duration);
  var info = {
    trackType: trackType,
    trackIndex: trackIndex,
    clipIndex: clipIndex,
    name: clip.name,
    start: _round(_sec(clip.start)),
    end: _round(_sec(clip.end)),
    duration: _round(duration),
    // The DOM's outPoint is not refreshed after trims, so derive it.
    sourceIn: _round(inPoint),
    sourceOut: _round(inPoint + duration * speed),
  };
  if (speed !== 1) info.speed = _round(speed);
  try {
    if (clip.isSpeedReversed()) {
      info.reversed = true;
      delete info.sourceIn;
      delete info.sourceOut;
    }
  } catch (ex) {}
  if (clip.disabled) info.enabled = false;
  try { if (clip.isSelected()) info.selected = true; } catch (ex) {}
  try { if (clip.isMGT()) info.isGraphic = true; } catch (ex) {}
  try { if (clip.isAdjustmentLayer()) info.isAdjustmentLayer = true; } catch (ex) {}
  try { if (clip.projectItem) info.projectItemId = clip.projectItem.nodeId; } catch (ex) {}
  return info;
}

function _forEachClip(seq, fn) {
  var kinds = [["video", seq.videoTracks], ["audio", seq.audioTracks]];
  for (var k = 0; k < kinds.length; k++) {
    var tracks = kinds[k][1];
    for (var t = 0; t < tracks.numTracks; t++) {
      for (var c = 0; c < tracks[t].clips.numItems; c++) {
        fn(tracks[t].clips[c], kinds[k][0], t, c);
      }
    }
  }
}

// Locate a clip again after an edit, by its start time on a given track.
function _clipIndexAt(trackType, trackIndex, startSeconds) {
  var track = _getTrack(trackType, trackIndex);
  var target = Number(_secondsToTicks(startSeconds));
  var half = Number(_seq().timebase) / 2;
  for (var c = 0; c < track.clips.numItems; c++) {
    if (Math.abs(Number(track.clips[c].start.ticks) - target) <= half) return c;
  }
  return -1;
}

/* ---------- components / properties ---------- */

function _norm(s) {
  return String(s || "").toLowerCase().replace(/^\s+|\s+$/g, "");
}

// effect may be an index or a (display/match) name; returns its index.
function _componentIndex(clip, effect) {
  var comps = clip.components;
  if (typeof effect === "number") {
    if (effect < 0 || effect >= comps.numItems) _fail("Effect index " + effect + " out of range (clip has " + comps.numItems + " components)");
    return effect;
  }
  var want = _norm(effect);
  for (var i = 0; i < comps.numItems; i++) {
    if (_norm(comps[i].displayName) === want || _norm(comps[i].matchName) === want) return i;
  }
  for (var j = 0; j < comps.numItems; j++) {
    if (_norm(comps[j].displayName).indexOf(want) >= 0) return j;
  }
  var names = [];
  for (var n = 0; n < comps.numItems; n++) names.push(comps[n].displayName);
  _fail("Effect '" + effect + "' not found on clip. Available: " + names.join(", "));
}

function _getComponent(clip, effect) {
  return clip.components[_componentIndex(clip, effect)];
}

function _findComponent(clip, displayName) {
  var want = _norm(displayName);
  for (var i = 0; i < clip.components.numItems; i++) {
    if (_norm(clip.components[i].displayName) === want) return clip.components[i];
  }
  return null;
}

function _getProperty(component, property) {
  var props = component.properties;
  if (typeof property === "number") {
    if (property < 0 || property >= props.numItems) _fail("Property index " + property + " out of range");
    return props[property];
  }
  var want = _norm(property);
  for (var i = 0; i < props.numItems; i++) {
    if (_norm(props[i].displayName) === want) return props[i];
  }
  var names = [];
  for (var n = 0; n < props.numItems; n++) if (props[n].displayName) names.push(props[n].displayName);
  _fail("Property '" + property + "' not found on '" + component.displayName + "'. Available: " + names.join(", "));
}

function _findProperty(component, displayName) {
  if (!component) return null;
  var want = _norm(displayName);
  for (var i = 0; i < component.properties.numItems; i++) {
    if (_norm(component.properties[i].displayName) === want) return component.properties[i];
  }
  return null;
}

function _plainValue(v) {
  if (v === undefined || v === null) return v;
  if (v instanceof Array) {
    var out = [];
    for (var i = 0; i < v.length; i++) out.push(_plainValue(v[i]));
    return out;
  }
  if (typeof v === "object") {
    if (v instanceof Number) return Number(v);
    if (v instanceof Boolean) return v == true;
    if (v instanceof String) return String(v);
    return String(v);
  }
  return v;
}

function _propValue(prop) {
  try { return _plainValue(prop.getValue()); } catch (ex) { return null; }
}

// Audio clip "Level" is stored as linear gain where 0.17782794 == 0 dB.
function _dbToLevel(db) {
  return Math.pow(10, (Number(db) - 15) / 20);
}

function _levelToDb(level) {
  if (level <= 0) return -Infinity;
  return _round(20 * Math.log(level) / Math.LN10 + 15);
}

/* ---------- project items ---------- */

function _findProjectItemByNodeId(root, nodeId) {
  for (var i = 0; i < root.children.numItems; i++) {
    var item = root.children[i];
    if (item.nodeId === nodeId) return item;
    if (item.type === ProjectItemType.BIN) {
      var found = _findProjectItemByNodeId(item, nodeId);
      if (found) return found;
    }
  }
  return null;
}

function _getItem(nodeId) {
  var item = _findProjectItemByNodeId(_project().rootItem, String(nodeId));
  if (!item) _fail("Project item not found: " + nodeId + " (use get_project_items or find_project_items to get nodeIds)");
  return item;
}

function _findBinByPath(binPath) {
  var current = _project().rootItem;
  if (!binPath) return current;
  var parts = String(binPath).split("/");
  for (var p = 0; p < parts.length; p++) {
    if (parts[p] === "") continue;
    var found = null;
    for (var i = 0; i < current.children.numItems; i++) {
      var child = current.children[i];
      if (child.type === ProjectItemType.BIN && child.name === parts[p]) {
        found = child;
        break;
      }
    }
    if (!found) return null;
    current = found;
  }
  return current;
}

function _getBin(binPath) {
  var bin = _findBinByPath(binPath);
  if (!bin) _fail("Bin not found: " + binPath);
  return bin;
}

function _itemTypeName(item) {
  if (item.type === ProjectItemType.BIN) return "bin";
  if (item.type === ProjectItemType.ROOT) return "root";
  try { if (item.isSequence()) return "sequence"; } catch (ex) {}
  if (item.type === ProjectItemType.FILE) return "file";
  if (item.type === ProjectItemType.CLIP) return "clip";
  return "unknown";
}

function _itemSummary(item, binPath) {
  var info = { name: item.name, nodeId: item.nodeId, type: _itemTypeName(item) };
  if (binPath) info.bin = binPath;
  if (item.type !== ProjectItemType.BIN) {
    try { var p = item.getMediaPath(); if (p) info.mediaPath = p; } catch (ex) {}
    try { if (item.isOffline()) info.offline = true; } catch (ex) {}
  }
  return info;
}

function _collectItems(root, recursive, binPath, out) {
  out = out || [];
  for (var i = 0; i < root.children.numItems; i++) {
    var item = root.children[i];
    out.push(_itemSummary(item, binPath));
    if (recursive && item.type === ProjectItemType.BIN) {
      _collectItems(item, true, (binPath ? binPath + "/" : "") + item.name, out);
    }
  }
  return out;
}

function _allItems(root, out) {
  out = out || [];
  for (var i = 0; i < root.children.numItems; i++) {
    var item = root.children[i];
    out.push(item);
    if (item.type === ProjectItemType.BIN) _allItems(item, out);
  }
  return out;
}

function _nodeIdSet() {
  var set = {};
  var items = _allItems(_project().rootItem);
  for (var i = 0; i < items.length; i++) set[items[i].nodeId] = true;
  return set;
}

// Find an item by media path, preferring ones not in `exclude` (importFiles
// returns no handle, so new items are found by diffing nodeIds).
function _findItemByMediaPath(path, exclude) {
  var want = String(path).replace(/\\/g, "/");
  var items = _allItems(_project().rootItem);
  var fallback = null;
  for (var i = items.length - 1; i >= 0; i--) {
    var mp;
    try { mp = String(items[i].getMediaPath()).replace(/\\/g, "/"); } catch (ex) { continue; }
    if (mp !== want) continue;
    if (!exclude || !exclude[items[i].nodeId]) return items[i];
    if (!fallback) fallback = items[i];
  }
  return fallback;
}

var _labelColors = ["violet", "iris", "caribbean", "lavender", "cerulean", "forest", "rose", "mango",
  "purple", "blue", "teal", "magenta", "tan", "green", "brown", "yellow"];

function _labelIndex(color) {
  if (typeof color === "number") return color;
  var idx = -1;
  for (var i = 0; i < _labelColors.length; i++) if (_labelColors[i] === _norm(color)) idx = i;
  if (idx < 0) _fail("Unknown label color '" + color + "'. Use 0-15 or one of: " + _labelColors.join(", "));
  return idx;
}
