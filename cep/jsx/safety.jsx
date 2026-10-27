/* Safety layer used by the server around edits: timeline snapshots (for change
   reports and noticing manual edits), stable clip IDs, checkpoints and dry runs.

   Premiere's scripting API records every razor, remove and move as its own undo
   step and has no undo groups, so a checkpoint (a copy of the sequence taken
   before an edit) is how a multi-step edit is reverted in one go. */

var _CHECKPOINT_BIN = "prmcp checkpoints";
var _CHECKPOINT_TAG = " · before ";

/* ---------- snapshots and clip IDs ---------- */

// Compact state of the active sequence's clips, compared by the server before
// and after each edit.
function timelineSnapshot() {
  var seq = app.project.activeSequence;
  if (!seq) return null;
  var clips = [];
  _forEachClip(seq, function (clip, type, t, c) {
    var speed = 1;
    try { speed = clip.getSpeed() || 1; } catch (ex) {}
    var item = {
      id: _clipId(clip),
      name: clip.name,
      track: (type === "video" ? "V" : "A") + (t + 1),
      trackType: type,
      trackIndex: t,
      clipIndex: c,
      start: _round(_sec(clip.start)),
      end: _round(_sec(clip.end)),
      sourceIn: _round(_sec(clip.inPoint) * speed),
    };
    if (speed !== 1) item.speed = _round(speed);
    if (clip.disabled) item.enabled = false;
    clips.push(item);
  });
  var tracks = { video: seq.videoTracks.numTracks, audio: seq.audioTracks.numTracks };
  return { sequenceId: seq.sequenceID, sequenceName: seq.name, tracks: tracks, clips: clips };
}

function _findClipById(seq, id) {
  var found = null;
  _forEachClip(seq, function (clip, type, t, c) {
    if (!found && _clipId(clip) === String(id)) found = { trackType: type, trackIndex: t, clipIndex: c, name: clip.name };
  });
  return found;
}

// Where clips are now, by ID: [{trackType, trackIndex, clipIndex}].
function resolveClipIds(ids) {
  var seq = _seq();
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var loc = _findClipById(seq, ids[i]);
    if (!loc) _fail("No clip with clipId " + ids[i] + " in the active sequence. It may have been deleted, or another sequence is open; call get_timeline_clips.");
    out.push(loc);
  }
  return out;
}

/* ---------- checkpoints ---------- */

function _clockStamp() {
  var d = new Date();
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function _checkpointBin() {
  return _findBinByPath(_CHECKPOINT_BIN) || _project().rootItem.createBin(_CHECKPOINT_BIN);
}

// Bin path ("A/B") of a project item, from its treePath ("\Project.prproj\A\B\Item").
function _binPathOf(item) {
  try {
    var parts = String(item.treePath).split("\\");
    var out = [];
    for (var i = 2; i < parts.length - 1; i++) if (parts[i] !== "") out.push(parts[i]);
    return out.join("/");
  } catch (ex) {
    return "";
  }
}

function _cloneActive() {
  var seq = _seq();
  var before = _sequenceIdSet();
  seq.clone();
  var copy = _newSequenceSince(before);
  if (!copy) _fail("Could not copy the sequence (clone failed)");
  // Cloning can switch the timeline to the copy; keep the original open.
  if (!_project().activeSequence || _project().activeSequence.sequenceID !== seq.sequenceID) {
    app.project.openSequence(seq.sequenceID);
  }
  return { seq: seq, copy: copy };
}

// Copy the active sequence into the checkpoints bin; the original stays open.
function createCheckpoint(label) {
  var pair = _cloneActive();
  var copy = pair.copy;
  try {
    copy.name = pair.seq.name + _CHECKPOINT_TAG + (label || "edit") + " " + _clockStamp();
    copy.projectItem.moveBin(_checkpointBin());
  } catch (ex) {
    try { app.project.deleteSequence(copy); } catch (ex2) {}
    throw ex;
  }
  return { name: copy.name, id: copy.sequenceID, of: pair.seq.name, ofId: pair.seq.sequenceID };
}

function _inCheckpointBin(seq) {
  return _binPathOf(seq.projectItem) === _CHECKPOINT_BIN;
}

// Delete one sequence, only if it is in the checkpoints bin (used for pruning).
function deleteCheckpoint(id) {
  var s = _findSequence(id);
  if (!s || !_inCheckpointBin(s)) return { deleted: false };
  if (_project().activeSequence && _project().activeSequence.sequenceID === s.sequenceID) return { deleted: false };
  app.project.deleteSequence(s);
  return { deleted: true };
}

function listCheckpoints() {
  var out = [];
  var bin = _findBinByPath(_CHECKPOINT_BIN);
  if (!bin) return out;
  var seqs = _project().sequences;
  for (var i = 0; i < seqs.numSequences; i++) {
    if (_inCheckpointBin(seqs[i])) out.push({ name: seqs[i].name, id: seqs[i].sequenceID });
  }
  return out;
}

// Delete every sequence in the checkpoints bin (never anything else).
function clearCheckpoints() {
  var list = listCheckpoints();
  var removed = 0;
  for (var i = 0; i < list.length; i++) {
    var s = _findSequence(list[i].id);
    if (s) { app.project.deleteSequence(s); removed++; }
  }
  return { removed: removed };
}

// Put a checkpoint back in place of the sequence it was copied from: it takes
// that sequence's name and bin and opens. The edited version is kept, renamed,
// in the checkpoints bin, never deleted.
function restoreCheckpoint(nameOrId, targetNameOrId) {
  var cp = _getSequence(nameOrId);
  var target = targetNameOrId ? _getSequence(targetNameOrId) : _seq();
  if (cp.sequenceID === target.sequenceID) _fail("That checkpoint is the open sequence; pass the edited sequence as target");
  var originalName = target.name;
  var targetBin = _binPathOf(target.projectItem);
  target.name = originalName + " · replaced " + _clockStamp();
  try { target.projectItem.moveBin(_checkpointBin()); } catch (ex) {}
  cp.name = originalName;
  try { cp.projectItem.moveBin(_findBinByPath(targetBin) || _project().rootItem); } catch (ex) {}
  app.project.openSequence(cp.sequenceID);
  return {
    restored: originalName,
    restoredId: cp.sequenceID,
    editedVersionKeptAs: target.name,
    editedVersionId: target.sequenceID,
    note: "Clip IDs changed (this is a different copy of the sequence): call get_timeline_clips before addressing clips. Nested sequences or other references to the edited version still point to it.",
  };
}

/* ---------- dry runs ---------- */

// Open a throwaway copy of the active sequence so an edit can be tried on it.
function beginDryRun() {
  var pair = _cloneActive();
  var copy = pair.copy;
  try {
    copy.name = pair.seq.name + " · preview " + _clockStamp();
    app.project.openSequence(copy.sequenceID);
    var active = _project().activeSequence;
    if (!active || active.sequenceID !== copy.sequenceID) _fail("Premiere did not open the preview copy, so the dry run was not started");
  } catch (ex) {
    try { app.project.openSequence(pair.seq.sequenceID); } catch (ex2) {}
    try { app.project.deleteSequence(copy); } catch (ex3) {}
    throw ex;
  }
  return { previewId: copy.sequenceID, previewName: copy.name, originalId: pair.seq.sequenceID };
}

// Delete the preview copy and reopen the original.
function endDryRun(previewId, originalId) {
  var preview = _findSequence(previewId);
  var original = _findSequence(originalId);
  if (original) app.project.openSequence(original.sequenceID);
  if (preview && preview.sequenceID !== originalId) app.project.deleteSequence(preview);
  return { ok: true };
}
