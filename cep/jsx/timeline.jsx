/* Timeline editing functions. Clips are addressed by trackType ("video" |
   "audio"), 0-based trackIndex and 0-based clipIndex (left to right). */

// Run fn with the sequence's timecode display switched to plain frame counts,
// so QE time strings are unambiguous at any frame rate / drop-frame setting.
function _withFrameDisplay(fn) {
  var seq = _seq();
  var q = _qeSeq();
  var old = seq.videoDisplayFormat;
  q.setVideoDisplayFormat(109);
  try {
    return fn(q);
  } finally {
    q.setVideoDisplayFormat(old);
  }
}

function _framesString(seconds) {
  return String(Math.round(Number(seconds) / _frameDuration(_seq())));
}

function _sortedClips(track) {
  var arr = [];
  for (var i = 0; i < track.clips.numItems; i++) arr.push(track.clips[i]);
  return arr;
}

function getTimelineClips(trackType, trackIndex) {
  var seq = _seq();
  var results = [];
  _forEachClip(seq, function (clip, type, t, c) {
    if (trackType && trackType !== "all" && type !== trackType) return;
    if (_has(trackIndex) && trackIndex >= 0 && t !== trackIndex) return;
    results.push(_clipInfo(clip, type, t, c));
  });
  return { sequence: seq.name, duration: _round(_seqEnd(seq)), clips: results };
}

function getClipInfo(trackType, trackIndex, clipIndex) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var info = _clipInfo(clip, trackType, trackIndex, clipIndex);
  var linked = _linkedItems(clip);
  info.linked = [];
  for (var l = 0; l < linked.length; l++) {
    if (linked[l].nodeId === clip.nodeId) continue;
    info.linked.push({ trackType: linked[l].mediaType === "Video" ? "video" : "audio", trackIndex: linked[l].parentTrackIndex, name: linked[l].name });
  }
  info.effects = [];
  for (var i = 0; i < clip.components.numItems; i++) info.effects.push({ index: i, name: clip.components[i].displayName, matchName: clip.components[i].matchName });
  return info;
}

function _placeClip(mode, nodeId, trackType, trackIndex, startSec, inSec, outSec) {
  var seq = _seq();
  var item = _getItem(nodeId);
  if (item.type === ProjectItemType.BIN) _fail("Cannot place a bin on the timeline");
  var track = _getTrack(trackType || "video", trackIndex);
  if (track.isLocked()) _fail((trackType || "video") + " track " + trackIndex + " is locked");

  var hasRange = (_has(inSec) && inSec >= 0) || (_has(outSec) && outSec >= 0);
  var oldIn = null, oldOut = null;
  if (hasRange) {
    oldIn = item.getInPoint().ticks;
    oldOut = item.getOutPoint().ticks;
    if (_has(inSec) && inSec >= 0) item.setInPoint(_secondsToTicks(inSec), 4);
    if (_has(outSec) && outSec >= 0) item.setOutPoint(_secondsToTicks(outSec), 4);
  }
  try {
    if (mode === "insert") track.insertClip(item, _secondsToTicks(startSec));
    else track.overwriteClip(item, _secondsToTicks(startSec));
  } finally {
    if (hasRange) {
      item.setInPoint(oldIn, 4);
      item.setOutPoint(oldOut, 4);
    }
  }

  var placed = [];
  _forEachClip(seq, function (clip, type, t, c) {
    if (clip.projectItem && clip.projectItem.nodeId === item.nodeId && Math.abs(_sec(clip.start) - startSec) < _frameDuration(seq)) {
      placed.push(_clipInfo(clip, type, t, c));
    }
  });
  return { mode: mode, placed: placed };
}

function insertClip(nodeId, trackType, trackIndex, startSec, inSec, outSec) {
  return _placeClip("insert", nodeId, trackType, trackIndex, startSec, inSec, outSec);
}

function overwriteClip(nodeId, trackType, trackIndex, startSec, inSec, outSec) {
  return _placeClip("overwrite", nodeId, trackType, trackIndex, startSec, inSec, outSec);
}

function appendClip(nodeId, trackType, trackIndex, inSec, outSec) {
  var track = _getTrack(trackType || "video", trackIndex);
  var end = 0;
  for (var i = 0; i < track.clips.numItems; i++) end = Math.max(end, _sec(track.clips[i].end));
  return _placeClip("overwrite", nodeId, trackType, trackIndex, end, inSec, outSec);
}

function removeClip(trackType, trackIndex, clipIndex, ripple, includeLinked) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var name = clip.name;
  var targets = includeLinked === false ? [clip] : _linkedItems(clip);
  for (var i = 0; i < targets.length; i++) targets[i].remove(!!ripple, true);
  return { removed: name, ripple: !!ripple, itemsRemoved: targets.length };
}

function moveClip(trackType, trackIndex, clipIndex, newStartSec, includeLinked) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var offset = newStartSec - _sec(clip.start);
  if (Math.abs(offset) < 1e-6) return _clipInfo(clip, trackType, trackIndex, clipIndex);
  var targets = includeLinked === false ? [clip] : _linkedItems(clip);
  var t = _makeTime(offset);
  for (var i = 0; i < targets.length; i++) targets[i].move(t);
  var idx = _clipIndexAt(trackType, trackIndex, newStartSec);
  if (idx < 0) _fail("Clip could not be moved there (blocked by another clip?)");
  return _clipInfo(_getClip(trackType, trackIndex, idx), trackType, trackIndex, idx);
}

function moveClipToTrack(trackType, trackIndex, clipIndex, targetTrackIndex) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var start = _sec(clip.start);
  _getTrack(trackType, targetTrackIndex);
  var qClip = _qeClip(trackType, trackIndex, clipIndex);
  var offset = targetTrackIndex - trackIndex;
  if (trackType === "video") qClip.moveToTrack(offset, 0, "0", false);
  else qClip.moveToTrack(0, offset, "0", false);
  var idx = _clipIndexAt(trackType, targetTrackIndex, start);
  if (idx < 0) _fail("Move failed (is the target track free at that time?)");
  return _clipInfo(_getClip(trackType, targetTrackIndex, idx), trackType, targetTrackIndex, idx);
}

// Timeline trim: change where the clip starts/ends in the sequence (the
// source in/out moves with it). Linked audio/video is trimmed too.
function trimClip(trackType, trackIndex, clipIndex, newStartSec, newEndSec, includeLinked) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var oldStart = _sec(clip.start);
  var targets = includeLinked === false ? [clip] : _linkedItems(clip);
  for (var i = 0; i < targets.length; i++) {
    var c = targets[i];
    if (Math.abs(_sec(c.start) - oldStart) > _frameDuration(_seq())) continue;
    if (_has(newEndSec) && newEndSec >= 0) c.end = _makeTime(newEndSec);
    if (_has(newStartSec) && newStartSec >= 0) {
      // Setting start alone keeps the source in point (shifting the content);
      // move the in point by the same amount for a real head trim.
      // inPoint is in speed-scaled units, so it moves by the timeline delta.
      var newIn = _sec(c.inPoint) + (newStartSec - _sec(c.start));
      if (newIn < -1e-6) _fail("Cannot extend the clip start before the beginning of its media");
      c.start = _makeTime(newStartSec);
      c.inPoint = _makeTime(Math.max(0, newIn));
    }
  }
  var start = _has(newStartSec) && newStartSec >= 0 ? newStartSec : oldStart;
  var idx = _clipIndexAt(trackType, trackIndex, start);
  return idx >= 0 ? _clipInfo(_getClip(trackType, trackIndex, idx), trackType, trackIndex, idx) : {};
}

function razorClip(trackType, trackIndex, timeSec) {
  _getTrack(trackType, trackIndex);
  _withFrameDisplay(function (q) {
    var qTrack = trackType === "video" ? q.getVideoTrackAt(trackIndex) : q.getAudioTrackAt(trackIndex);
    qTrack.razor(_framesString(timeSec));
  });
  return { cutAt: timeSec, track: trackType + " " + trackIndex };
}

function razorAllTracks(timeSec) {
  var seq = _seq();
  _withFrameDisplay(function (q) {
    var frames = _framesString(timeSec);
    for (var v = 0; v < seq.videoTracks.numTracks; v++) if (!seq.videoTracks[v].isLocked()) q.getVideoTrackAt(v).razor(frames);
    for (var a = 0; a < seq.audioTracks.numTracks; a++) if (!seq.audioTracks[a].isLocked()) q.getAudioTrackAt(a).razor(frames);
  });
  return { cutAt: timeSec };
}

// Remove the section between two times on all unlocked tracks and close the gap.
function rippleDeleteRange(startSec, endSec) {
  if (endSec <= startSec) _fail("endTime must be greater than startTime");
  var seq = _seq();
  razorAllTracks(startSec);
  razorAllTracks(endSec);
  var fd = _frameDuration(seq);
  var removed = 0;
  var kinds = [seq.videoTracks, seq.audioTracks];
  for (var k = 0; k < kinds.length; k++) {
    for (var t = 0; t < kinds[k].numTracks; t++) {
      var track = kinds[k][t];
      if (track.isLocked()) continue;
      for (var c = track.clips.numItems - 1; c >= 0; c--) {
        var clip = track.clips[c];
        if (_sec(clip.start) >= startSec - fd / 2 && _sec(clip.end) <= endSec + fd / 2) {
          clip.remove(false, true);
          removed++;
        }
      }
    }
  }
  _shiftAfter(endSec, startSec - endSec);
  return { removedRange: [startSec, endSec], clipsRemoved: removed };
}

// Move every clip that starts at/after `fromSec` by offsetSec, on all unlocked tracks.
function _shiftAfter(fromSec, offsetSec) {
  var seq = _seq();
  var fd = _frameDuration(seq);
  var t = _makeTime(offsetSec);
  var kinds = [seq.videoTracks, seq.audioTracks];
  for (var k = 0; k < kinds.length; k++) {
    for (var tr = 0; tr < kinds[k].numTracks; tr++) {
      var track = kinds[k][tr];
      if (track.isLocked()) continue;
      var clips = _sortedClips(track);
      if (offsetSec > 0) clips.reverse();
      for (var c = 0; c < clips.length; c++) {
        if (_sec(clips[c].start) >= fromSec - fd / 2) clips[c].move(t);
      }
    }
  }
}

// Close every gap on one track (or all unlocked tracks when trackIndex < 0),
// moving clips left. Linked clips on other tracks are not moved.
function closeGaps(trackType, trackIndex) {
  var seq = _seq();
  var closed = 0;
  var types = trackType === "all" || !trackType ? ["video", "audio"] : [trackType];
  for (var k = 0; k < types.length; k++) {
    var tracks = _tracks(seq, types[k]);
    for (var t = 0; t < tracks.numTracks; t++) {
      if (_has(trackIndex) && trackIndex >= 0 && t !== trackIndex) continue;
      var track = tracks[t];
      if (track.isLocked()) continue;
      var cursor = 0;
      var clips = _sortedClips(track);
      for (var c = 0; c < clips.length; c++) {
        var gap = _sec(clips[c].start) - cursor;
        if (gap > _frameDuration(seq) / 2) {
          clips[c].move(_makeTime(-gap));
          closed++;
        }
        cursor = _sec(track.clips[c].end);
      }
    }
  }
  return { gapsClosed: closed };
}

// QE setSpeed(speed, duration, reverse, maintainPitch, rippleThisTrack) has
// quirks: with an empty duration it refits the clip to the rest of the media
// and caps the speed at media/(inPoint + duration). So the speed is applied
// with a 1-frame duration (repeated until the cap no longer bites) and the
// clip is then extended to its real length. Each linked item is done
// separately and any ripple is done here across all tracks.
function _applySpeed(type, track, start, speed, reverse, maintainPitch) {
  var idx = _clipIndexAt(type, track, start);
  if (idx < 0) return;
  for (var i = 0; i < 8; i++) {
    _withFrameDisplay(function () {
      _qeClip(type, track, idx).setSpeed(speed, "1", !!reverse, !!maintainPitch, false);
    });
    idx = _clipIndexAt(type, track, start);
    if (idx < 0 || Math.abs((_getClip(type, track, idx).getSpeed() || 1) - speed) < 1e-4) return;
  }
  _fail("Premiere could not set the speed to " + speed);
}

function setClipSpeed(trackType, trackIndex, clipIndex, speed, reverse, ripple, maintainPitch) {
  if (!(speed > 0)) _fail("speed must be > 0 (1 = normal, 2 = double speed, 0.5 = half speed)");
  var seq = _seq();
  var fd = _frameDuration(seq);
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var start = _sec(clip.start);
  var oldEnd = _sec(clip.end);
  var oldSpeed = clip.getSpeed() || 1;
  var targetEnd = start + Math.max(1, Math.round((oldEnd - start) * oldSpeed / speed / fd)) * fd;

  var parts = [];
  var linked = _linkedItems(clip);
  for (var i = 0; i < linked.length; i++) {
    parts.push({ type: linked[i].mediaType === "Video" ? "video" : "audio", track: linked[i].parentTrackIndex });
  }

  // Room available before the next clip on any of the involved tracks.
  var limit = Infinity;
  for (var p = 0; p < parts.length; p++) {
    var tr = _getTrack(parts[p].type, parts[p].track);
    for (var n = 0; n < tr.clips.numItems; n++) {
      var s0 = _sec(tr.clips[n].start);
      if (s0 > start + fd / 2 && s0 < limit) limit = s0;
    }
  }

  if (ripple && targetEnd > oldEnd) {
    _shiftAfter(oldEnd - fd / 2, targetEnd - oldEnd);
    limit += targetEnd - oldEnd;
  }

  for (var q = 0; q < parts.length; q++) _applySpeed(parts[q].type, parts[q].track, start, speed, reverse, maintainPitch !== false);

  var newEnd = Math.min(targetEnd, limit);
  for (var r = 0; r < parts.length; r++) {
    var ix = _clipIndexAt(parts[r].type, parts[r].track, start);
    if (ix >= 0) _getClip(parts[r].type, parts[r].track, ix).end = _makeTime(newEnd);
  }

  if (ripple && targetEnd < oldEnd) _shiftAfter(oldEnd - fd / 2, targetEnd - oldEnd);

  var idx2 = _clipIndexAt(trackType, trackIndex, start);
  var info = _clipInfo(_getClip(trackType, trackIndex, idx2), trackType, trackIndex, idx2);
  if (newEnd < targetEnd - fd / 2) info.note = "Clip was shortened to fit before the next clip; use ripple=true to push later clips.";
  return info;
}

function setClipEnabled(trackType, trackIndex, clipIndex, enabled) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  clip.disabled = !enabled;
  return { enabled: !clip.disabled };
}

function renameClip(trackType, trackIndex, clipIndex, newName) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  clip.name = newName;
  return { name: clip.name };
}

function _selectOnly(clips) {
  var seq = _seq();
  _forEachClip(seq, function (c) { if (c.isSelected()) c.setSelected(false, true); });
  for (var i = 0; i < clips.length; i++) clips[i].setSelected(true, true);
}

function linkClips(clipRefs) {
  var clips = [];
  for (var i = 0; i < clipRefs.length; i++) clips.push(_getClip(clipRefs[i].trackType, clipRefs[i].trackIndex, clipRefs[i].clipIndex));
  _selectOnly(clips);
  _seq().linkSelection();
  return { linked: clips.length };
}

function unlinkClip(trackType, trackIndex, clipIndex) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  _selectOnly(_linkedItems(clip));
  _seq().unlinkSelection();
  _selectOnly([]);
  return {};
}

// Apply a QE edit to the clip and every item linked to it (QE edits touch a
// single item only).
function _eachLinkedQe(trackType, trackIndex, clipIndex, fn) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var start = _sec(clip.start);
  var linked = _linkedItems(clip);
  var parts = [];
  for (var i = 0; i < linked.length; i++) parts.push({ type: linked[i].mediaType === "Video" ? "video" : "audio", track: linked[i].parentTrackIndex });
  _withFrameDisplay(function () {
    for (var p = 0; p < parts.length; p++) {
      var idx = _clipIndexAt(parts[p].type, parts[p].track, start);
      if (idx >= 0) fn(_qeClip(parts[p].type, parts[p].track, idx));
    }
  });
  return start;
}

// Positive offset shows later source content; position and length stay put.
function slipClip(trackType, trackIndex, clipIndex, offsetSec) {
  _eachLinkedQe(trackType, trackIndex, clipIndex, function (q) { q.slip(_framesString(-offsetSec), false); });
  return getClipInfo(trackType, trackIndex, clipIndex);
}

// Move the clip along the timeline, trimming its neighbours to compensate.
function slideClip(trackType, trackIndex, clipIndex, offsetSec) {
  var start = _eachLinkedQe(trackType, trackIndex, clipIndex, function (q) { q.slide(_framesString(offsetSec), false); });
  var idx = _clipIndexAt(trackType, trackIndex, start + offsetSec);
  return idx >= 0 ? _clipInfo(_getClip(trackType, trackIndex, idx), trackType, trackIndex, idx) : {};
}

function duplicateClip(trackType, trackIndex, clipIndex, targetTimeSec, targetTrackIndex) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  if (!clip.projectItem) _fail("This clip has no source project item");
  var info = _clipInfo(clip, trackType, trackIndex, clipIndex);
  var inSec = info.sourceIn;
  var outSec = info.sourceOut;
  return _placeClip("overwrite", clip.projectItem.nodeId, trackType, _has(targetTrackIndex) && targetTrackIndex >= 0 ? targetTrackIndex : trackIndex, targetTimeSec, inSec, outSec);
}

function getSelection() {
  var seq = _seq();
  var out = [];
  _forEachClip(seq, function (clip, type, t, c) { if (clip.isSelected()) out.push(_clipInfo(clip, type, t, c)); });
  return out;
}

function selectClips(clipRefs, addToSelection) {
  var clips = [];
  for (var i = 0; i < clipRefs.length; i++) clips.push(_getClip(clipRefs[i].trackType, clipRefs[i].trackIndex, clipRefs[i].clipIndex));
  if (!addToSelection) _selectOnly(clips);
  else for (var j = 0; j < clips.length; j++) clips[j].setSelected(true, true);
  return { selected: getSelection().length };
}

function deselectAll() {
  _selectOnly([]);
  return {};
}

function findClips(nameQuery) {
  var q = _norm(nameQuery);
  var out = [];
  _forEachClip(_seq(), function (clip, type, t, c) {
    if (_norm(clip.name).indexOf(q) >= 0) out.push(_clipInfo(clip, type, t, c));
  });
  return out;
}

function getClipsAtTime(timeSec) {
  var out = [];
  _forEachClip(_seq(), function (clip, type, t, c) {
    if (_sec(clip.start) <= timeSec && _sec(clip.end) > timeSec) out.push(_clipInfo(clip, type, t, c));
  });
  return out;
}
