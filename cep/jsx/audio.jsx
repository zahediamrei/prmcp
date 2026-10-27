/* Audio levels. Clip levels are in dB (0 = unchanged); track volume is the
   Audio Track Mixer fader, also in dB. */

function _volumeLevel(clip) {
  var comp = _findComponent(clip, "Volume");
  var prop = _findProperty(comp, "Level");
  if (!prop) _fail("This clip has no Volume effect (is it an audio clip?)");
  return prop;
}

function _audioClip(trackIndex, clipIndex) {
  return _getClip("audio", trackIndex, clipIndex);
}

function setClipVolume(trackIndex, clipIndex, volumeDb, timeSec) {
  var clip = _audioClip(trackIndex, clipIndex);
  var prop = _volumeLevel(clip);
  var level = _dbToLevel(volumeDb);
  if ((_has(timeSec) && timeSec >= 0) || prop.isTimeVarying()) {
    var t = _has(timeSec) && timeSec >= 0 ? timeSec : _sec(_seq().getPlayerPosition());
    if (t < _sec(clip.start) || t > _sec(clip.end)) _fail("Time " + t + "s is outside the clip");
    if (!prop.isTimeVarying()) prop.setTimeVarying(true, true);
    var mt = _toMediaTime(clip, t);
    if (!prop.keyExistsAtTime(mt)) prop.addKey(mt);
    prop.setValueAtKey(mt, level, true);
    return { volumeDb: volumeDb, keyframeAt: t, keyframes: getClipVolume(trackIndex, clipIndex).keyframes };
  }
  prop.setValue(level, true);
  return { volumeDb: _levelToDb(prop.getValue()) };
}

function getClipVolume(trackIndex, clipIndex) {
  var clip = _audioClip(trackIndex, clipIndex);
  var prop = _volumeLevel(clip);
  var out = {};
  if (prop.isTimeVarying()) {
    // Animated: the static value is meaningless, report the keyframes.
    var keys = _keyframesOf(prop, clip);
    for (var i = 0; i < keys.length; i++) keys[i].value = _levelToDb(keys[i].value);
    out.keyframes = keys;
  } else {
    out.volumeDb = _levelToDb(Number(prop.getValue()));
  }
  var cv = _findComponent(clip, "Channel Volume");
  if (cv) {
    out.leftDb = _levelToDb(Number(_findProperty(cv, "Left").getValue()));
    out.rightDb = _levelToDb(Number(_findProperty(cv, "Right").getValue()));
  }
  return out;
}

// Fade the clip's volume in and/or out with keyframes (seconds of fade).
function fadeClipVolume(trackIndex, clipIndex, fadeInSec, fadeOutSec, volumeDb) {
  var clip = _audioClip(trackIndex, clipIndex);
  var prop = _volumeLevel(clip);
  var base = _has(volumeDb) ? volumeDb : _levelToDb(Number(prop.getValue()));
  var start = _sec(clip.start), end = _sec(clip.end);
  var fd = _frameDuration(_seq());
  var silent = -96;
  if (fadeInSec > 0) {
    setClipVolume(trackIndex, clipIndex, silent, start);
    setClipVolume(trackIndex, clipIndex, base, Math.min(start + fadeInSec, end));
  }
  if (fadeOutSec > 0) {
    setClipVolume(trackIndex, clipIndex, base, Math.max(end - fadeOutSec, start));
    setClipVolume(trackIndex, clipIndex, silent, end - fd);
  }
  return getClipVolume(trackIndex, clipIndex);
}

// Left/right channel levels of a stereo clip (a way to balance/pan it).
function setClipChannelVolume(trackIndex, clipIndex, leftDb, rightDb) {
  var clip = _audioClip(trackIndex, clipIndex);
  var cv = _findComponent(clip, "Channel Volume");
  if (!cv) _fail("This clip has no Channel Volume (only stereo/multichannel clips do)");
  if (_has(leftDb)) _findProperty(cv, "Left").setValue(_dbToLevel(leftDb), true);
  if (_has(rightDb)) _findProperty(cv, "Right").setValue(_dbToLevel(rightDb), true);
  return getClipVolume(trackIndex, clipIndex);
}

function _trackVolumeComponent(trackIndex) {
  var q = _qeTrack("audio", trackIndex);
  for (var i = 0; i < q.numComponents; i++) {
    var c = q.getComponentAt(i);
    var params = c.getParamList();
    for (var j = 0; j < params.length; j++) if (params[j] === "Volume") return c;
  }
  _fail("Track volume control not found");
}

function setTrackVolume(trackIndex, volumeDb) {
  if (volumeDb > 6) _fail("Track volume can't exceed +6 dB");
  var gain = volumeDb <= -96 ? 0 : Math.pow(10, volumeDb / 20);
  var c = _trackVolumeComponent(trackIndex);
  c.setParamValue("Volume", gain.toFixed(4));
  return getTrackVolume(trackIndex);
}

function getTrackVolume(trackIndex) {
  var c = _trackVolumeComponent(trackIndex);
  var gain = Number(c.getParamValue("Volume"));
  return { trackIndex: trackIndex, volumeDb: gain <= 0 ? -Infinity : _round(20 * Math.log(gain) / Math.LN10) };
}

function setClipMute(trackIndex, clipIndex, muted) {
  var clip = _audioClip(trackIndex, clipIndex);
  clip.disabled = !!muted;
  return { muted: clip.disabled };
}
