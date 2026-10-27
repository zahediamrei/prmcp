/* Sequence and track functions */

function _seqSummary(seq) {
  var st = seq.getSettings();
  return {
    name: seq.name,
    id: seq.sequenceID,
    width: st.videoFrameWidth,
    height: st.videoFrameHeight,
    fps: _round(1 / _ticksToSeconds(seq.timebase)),
    duration: _round(_seqEnd(seq)),
    videoTracks: seq.videoTracks.numTracks,
    audioTracks: seq.audioTracks.numTracks,
  };
}

function _sequenceIdSet() {
  var set = {};
  for (var i = 0; i < app.project.sequences.numSequences; i++) set[app.project.sequences[i].sequenceID] = true;
  return set;
}

function _newSequenceSince(before) {
  for (var i = 0; i < app.project.sequences.numSequences; i++) {
    if (!before[app.project.sequences[i].sequenceID]) return app.project.sequences[i];
  }
  return null;
}

function _getSequence(nameOrId) {
  var seq = _findSequence(nameOrId);
  if (!seq) _fail("Sequence not found: " + nameOrId + " (use get_sequences)");
  return seq;
}

function getSequences() {
  var proj = _project();
  var active = proj.activeSequence ? proj.activeSequence.sequenceID : null;
  var out = [];
  for (var i = 0; i < proj.sequences.numSequences; i++) {
    var info = _seqSummary(proj.sequences[i]);
    if (info.id === active) info.active = true;
    out.push(info);
  }
  return out;
}

function _trackSummary(track, index) {
  var info = { index: index, name: track.name, clips: track.clips.numItems, muted: track.isMuted() };
  try { info.locked = track.isLocked(); } catch (ex) {}
  try { info.targeted = track.isTargeted(); } catch (ex) {}
  return info;
}

function getActiveSequence() {
  var seq = _seq();
  var info = _seqSummary(seq);
  info.playhead = _round(_sec(seq.getPlayerPosition()));
  var inP = _sec(seq.getInPointAsTime()), outP = _sec(seq.getOutPointAsTime());
  if (inP > 0 || (outP > 0 && outP < _seqEnd(seq))) {
    info.inPoint = _round(Math.max(0, inP));
    info.outPoint = _round(outP);
  }
  info.video = [];
  info.audio = [];
  for (var v = 0; v < seq.videoTracks.numTracks; v++) info.video.push(_trackSummary(seq.videoTracks[v], v));
  for (var a = 0; a < seq.audioTracks.numTracks; a++) info.audio.push(_trackSummary(seq.audioTracks[a], a));
  info.markers = seq.markers.numMarkers;
  return info;
}

function getSequenceSettings() {
  var seq = _seq();
  var st = seq.getSettings();
  return {
    name: seq.name,
    width: st.videoFrameWidth,
    height: st.videoFrameHeight,
    fps: _round(1 / st.videoFrameRate.seconds),
    pixelAspectRatio: st.videoPixelAspectRatio,
    fieldType: st.videoFieldType,
    audioSampleRate: Math.round(1 / st.audioSampleRate.seconds),
    audioChannelCount: st.audioChannelCount,
    maximumBitDepth: st.maximumBitDepth,
    maximumRenderQuality: st.maximumRenderQuality,
    workingColorSpace: st.workingColorSpace ? st.workingColorSpace.name : null,
  };
}

function setSequenceSettings(width, height, fps, maxBitDepth, maxRenderQuality) {
  var seq = _seq();
  var st = seq.getSettings();
  if (_has(width) && width > 0) st.videoFrameWidth = width;
  if (_has(height) && height > 0) st.videoFrameHeight = height;
  if (_has(fps) && fps > 0) {
    var fr = new Time();
    fr.ticks = String(Math.round(TICKS_PER_SECOND / _ntscRate(fps)));
    st.videoFrameRate = fr;
  }
  if (_has(maxBitDepth)) st.maximumBitDepth = !!maxBitDepth;
  if (_has(maxRenderQuality)) st.maximumRenderQuality = !!maxRenderQuality;
  seq.setSettings(st);
  return getSequenceSettings();
}

// 29.97 / 23.976 / 59.94 are really 30000/1001 etc.
function _ntscRate(fps) {
  var ntsc = { "23.976": 24000 / 1001, "23.98": 24000 / 1001, "29.97": 30000 / 1001, "59.94": 60000 / 1001, "47.952": 48000 / 1001, "119.88": 120000 / 1001 };
  var key = String(Math.round(fps * 1000) / 1000);
  return ntsc[key] || Number(fps);
}

function setActiveSequence(nameOrId) {
  var seq = _getSequence(nameOrId);
  app.project.openSequence(seq.sequenceID);
  return _seqSummary(app.project.activeSequence);
}

function _presetDir() {
  return app.path.replace(/\/?$/, "/") + "Contents/Settings/SequencePresets/";
}

function createSequence(name, width, height, fps, presetPath) {
  var proj = _project();
  var before = _sequenceIdSet();
  if (presetPath) {
    if (!new File(presetPath).exists) _fail("Preset not found: " + presetPath);
    _qe().project.newSequence(name, presetPath);
  } else {
    var preset = new File(_presetDir() + "HD 1080p/HD 1080p 25 fps.sqpreset");
    if (!preset.exists) {
      preset = new File(app.path + "Settings/SequencePresets/HD 1080p/HD 1080p 25 fps.sqpreset");
    }
    if (!preset.exists) _fail("Default sequence preset not found; pass presetPath");
    _qe().project.newSequence(name, preset.fsName);
  }
  var seq = _newSequenceSince(before);
  if (!seq) _fail("Sequence was not created");
  proj.openSequence(seq.sequenceID);
  if (!presetPath || width || height || fps) {
    setSequenceSettings(width || (presetPath ? null : 1920), height || (presetPath ? null : 1080), fps || (presetPath ? null : 25));
  }
  return _seqSummary(app.project.activeSequence);
}

function createSequenceFromClips(name, nodeIds, binPath) {
  var items = [];
  for (var i = 0; i < nodeIds.length; i++) items.push(_getItem(nodeIds[i]));
  var seq = app.project.createNewSequenceFromClips(name || items[0].name, items, _getBin(binPath || ""));
  if (!seq) _fail("Could not create sequence from clips");
  return _seqSummary(seq);
}

function cloneSequence(nameOrId, newName) {
  var seq = nameOrId ? _getSequence(nameOrId) : _seq();
  var before = _sequenceIdSet();
  seq.clone();
  var copy = _newSequenceSince(before);
  if (!copy) _fail("Clone failed");
  if (newName) copy.name = newName;
  return _seqSummary(copy);
}

function renameSequence(nameOrId, newName) {
  var seq = _getSequence(nameOrId);
  seq.name = newName;
  return { name: seq.name, id: seq.sequenceID };
}

function deleteSequence(nameOrId) {
  var seq = _getSequence(nameOrId);
  var name = seq.name;
  app.project.deleteSequence(seq);
  return { deleted: name };
}

function setSequenceInOut(inPointSec, outPointSec) {
  var seq = _seq();
  if (_has(inPointSec) && inPointSec >= 0) seq.setInPoint(_secondsToTicks(inPointSec));
  if (_has(outPointSec) && outPointSec >= 0) seq.setOutPoint(_secondsToTicks(outPointSec));
  return { inPoint: _round(_sec(seq.getInPointAsTime())), outPoint: _round(_sec(seq.getOutPointAsTime())) };
}

function clearSequenceInOut() {
  var seq = _seq();
  seq.setInPoint("0");
  seq.setOutPoint(String(seq.end));
  return { inPoint: 0, outPoint: _round(_seqEnd(seq)) };
}

function addTracks(videoCount, audioCount, audioType) {
  var seq = _seq();
  var types = { mono: 0, stereo: 1, "5.1": 2, adaptive: 3 };
  var aType = types[audioType || "stereo"];
  if (aType === undefined) aType = 1;
  _qeSeq().addTracks(videoCount || 0, seq.videoTracks.numTracks, audioCount || 0, aType, seq.audioTracks.numTracks, 0, 0, 0);
  return { videoTracks: seq.videoTracks.numTracks, audioTracks: seq.audioTracks.numTracks };
}

function removeTrack(trackType, trackIndex) {
  var track = _getTrack(trackType, trackIndex);
  if (track.clips.numItems > 0) _fail("Track is not empty (" + track.clips.numItems + " clips). Remove its clips first.");
  var q = _qeSeq();
  if (trackType === "video") q.removeVideoTrack(trackIndex);
  else q.removeAudioTrack(trackIndex);
  var seq = _seq();
  return { videoTracks: seq.videoTracks.numTracks, audioTracks: seq.audioTracks.numTracks };
}

function removeEmptyTracks() {
  var q = _qeSeq();
  q.removeEmptyVideoTracks();
  q.removeEmptyAudioTracks();
  var seq = _seq();
  return { videoTracks: seq.videoTracks.numTracks, audioTracks: seq.audioTracks.numTracks };
}

function getTrackInfo(trackType, trackIndex) {
  var track = _getTrack(trackType, trackIndex);
  var info = _trackSummary(track, trackIndex);
  info.type = trackType;
  info.items = [];
  for (var i = 0; i < track.clips.numItems; i++) info.items.push(_clipInfo(track.clips[i], trackType, trackIndex, i));
  return info;
}

function setTrackMuted(trackType, trackIndex, muted) {
  var track = _getTrack(trackType, trackIndex);
  track.setMute(muted ? 1 : 0);
  return { muted: track.isMuted() };
}

function setTrackLocked(trackType, trackIndex, locked) {
  var track = _getTrack(trackType, trackIndex);
  track.setLocked(locked ? 1 : 0);
  return { locked: track.isLocked() };
}

function setTrackTargeted(trackType, trackIndex, targeted) {
  var track = _getTrack(trackType, trackIndex);
  track.setTargeted(!!targeted, true);
  return { targeted: track.isTargeted() };
}

function renameTrack(trackType, trackIndex, name) {
  _qeTrack(trackType, trackIndex).setName(name);
  return { name: _getTrack(trackType, trackIndex).name };
}

function autoReframeSequence(numerator, denominator, motionPreset, newName, useNested) {
  var seq = _seq();
  var name = newName || (seq.name + " " + numerator + "x" + denominator);
  var presets = { slower: "slower", "default": "default", faster: "faster" };
  var result = seq.autoReframeSequence(numerator, denominator, presets[motionPreset] || "default", name, !!useNested);
  if (!result) _fail("Auto Reframe failed");
  return _seqSummary(result);
}

function sceneEditDetection(action, applyCutsToLinkedAudio, sensitivity) {
  var seq = _seq();
  if (seq.getSelection().length === 0) _fail("Select the clips to analyze first (select_clips)");
  seq.performSceneEditDetectionOnSelection(action, !!applyCutsToLinkedAudio, sensitivity || "MediumSensitivity");
  return { action: action, note: "Scene edit detection runs in the background; re-read the timeline once it finishes." };
}

function createSubsequence(ignoreTrackTargeting) {
  var seq = _seq();
  var sub = seq.createSubsequence(!!ignoreTrackTargeting);
  if (!sub) _fail("Could not create subsequence (set sequence in/out points first)");
  return _seqSummary(sub);
}

function closeSequence(nameOrId) {
  var seq = nameOrId ? _getSequence(nameOrId) : _seq();
  seq.close();
  return {};
}

