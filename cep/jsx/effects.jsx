/* Effects, transitions, keyframes and Motion/Opacity shortcuts.
   Keyframe times in this API are sequence (timeline) seconds; Premiere stores
   them in source-media time, so they are converted here. */

var _interpModes = { linear: 0, hold: 4, bezier: 5, ease: 5, ease_in: 5, ease_out: 5, ease_in_out: 5 };
var _interpNames = { 0: "linear", 4: "hold", 5: "bezier", 6: "time" };

function _listFromQE(kind) {
  var q = _qe().project;
  if (kind === "video") return q.getVideoEffectList();
  if (kind === "audio") return q.getAudioEffectList();
  if (kind === "videoTransitions") return q.getVideoTransitionList();
  if (kind === "audioTransitions") return q.getAudioTransitionList();
  _fail("kind must be video, audio, videoTransitions or audioTransitions");
}

function getEffectsList(kind, filter) {
  var list = _listFromQE(kind);
  var f = _norm(filter);
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (!f || _norm(list[i]).indexOf(f) >= 0) out.push(list[i]);
  }
  return { kind: kind, count: out.length, names: out };
}

function _closestName(kind, name) {
  var list = _listFromQE(kind);
  var want = _norm(name);
  var partial = [];
  for (var i = 0; i < list.length; i++) {
    if (_norm(list[i]) === want) return list[i];
    if (_norm(list[i]).indexOf(want) >= 0) partial.push(list[i]);
  }
  if (partial.length === 1) return partial[0];
  _fail("'" + name + "' not found." + (partial.length ? " Did you mean: " + partial.slice(0, 10).join(", ") + "?" : " Use get_effects_list to see names."));
}

function applyEffect(trackType, trackIndex, clipIndex, effectName) {
  var q = _qeClip(trackType, trackIndex, clipIndex);
  var name;
  if (trackType === "video") {
    name = _closestName("video", effectName);
    q.addVideoEffect(_qe().project.getVideoEffectByName(name));
  } else {
    name = _closestName("audio", effectName);
    q.addAudioEffect(_qe().project.getAudioEffectByName(name));
  }
  var clip = _getClip(trackType, trackIndex, clipIndex);
  return { applied: name, effectIndex: clip.components.numItems - 1 };
}

function removeEffect(trackType, trackIndex, clipIndex, effect) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var index = _componentIndex(clip, effect);
  var comp = clip.components[index];
  var fixed = /^(AE\.ADBE (Opacity|Motion)|Internal Volume|AE\.ADBE Time Remapping)/;
  if (fixed.test(comp.matchName) || /^(Opacity|Motion|Volume|Channel Volume|Panner|Time Remapping)$/.test(comp.displayName)) {
    _fail("'" + comp.displayName + "' is a built-in component and cannot be removed; reset its values instead.");
  }
  _qeClip(trackType, trackIndex, clipIndex).getComponentAt(index).remove();
  return { removed: comp.displayName };
}

function _propInfo(prop, index, clip) {
  var info = { index: index, name: prop.displayName, value: _propValue(prop) };
  try {
    if (prop.isTimeVarying()) {
      info.keyframes = _keyframesOf(prop, clip);
    }
  } catch (ex) {}
  return info;
}

function getClipEffects(trackType, trackIndex, clipIndex) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var out = [];
  for (var i = 0; i < clip.components.numItems; i++) {
    var comp = clip.components[i];
    var props = [];
    for (var j = 0; j < comp.properties.numItems; j++) {
      var p = comp.properties[j];
      if (!p.displayName || /^_ /.test(p.displayName)) continue;
      props.push(_propInfo(p, j, clip));
    }
    out.push({ index: i, name: comp.displayName, matchName: comp.matchName, properties: props });
  }
  return out;
}

function _coerceValue(prop, value) {
  var cur = _propValue(prop);
  if (cur instanceof Array && !(value instanceof Array)) _fail("'" + prop.displayName + "' expects an array like " + JSON.stringify(cur));
  if (typeof cur === "boolean") return !!value;
  if (typeof cur === "number" && typeof value === "string" && value !== "" && !isNaN(Number(value))) return Number(value);
  return value;
}

function getEffectProperty(trackType, trackIndex, clipIndex, effect, property) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var prop = _getProperty(_getComponent(clip, effect), property);
  return _propInfo(prop, null, clip);
}

// Sets a property. If the property already has keyframes and no time is
// given, the value at the playhead gets a keyframe instead of being ignored.
function setEffectProperty(trackType, trackIndex, clipIndex, effect, property, value, timeSec) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var comp = _getComponent(clip, effect);
  var prop = _getProperty(comp, property);
  var v = _coerceValue(prop, value);
  if (_has(timeSec) && timeSec >= 0) return addKeyframe(trackType, trackIndex, clipIndex, effect, property, timeSec, value, null);
  if (prop.isTimeVarying()) {
    var t = _sec(_seq().getPlayerPosition());
    return addKeyframe(trackType, trackIndex, clipIndex, effect, property, t, value, null);
  }
  prop.setValue(v, true);
  return { effect: comp.displayName, property: prop.displayName, value: _propValue(prop) };
}

/* ---------- keyframes ---------- */

// Keyframes live in source-media time. The DOM in point is divided by the
// clip speed, so the real source in point is inPoint * speed.
function _toMediaTime(clip, seqSec) {
  var speed = clip.getSpeed() || 1;
  return _makeTime((_sec(clip.inPoint) + (seqSec - _sec(clip.start))) * speed);
}

function _toSeqTime(clip, mediaTime) {
  var speed = clip.getSpeed() || 1;
  return _sec(clip.start) + _sec(mediaTime) / speed - _sec(clip.inPoint);
}

function _keyframesOf(prop, clip) {
  var keys = prop.getKeys();
  var out = [];
  if (!keys) return out;
  for (var k = 0; k < keys.length; k++) {
    var item = { index: k, time: _round(_toSeqTime(clip, keys[k])), value: _plainValue(prop.getValueAtKey(keys[k])) };
    out.push(item);
  }
  return out;
}

function addKeyframe(trackType, trackIndex, clipIndex, effect, property, timeSec, value, interpolation) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var comp = _getComponent(clip, effect);
  var prop = _getProperty(comp, property);
  if (!prop.areKeyframesSupported()) _fail("'" + prop.displayName + "' cannot be keyframed");
  var v = _coerceValue(prop, value);
  if (timeSec < _sec(clip.start) - 1e-6 || timeSec > _sec(clip.end) + 1e-6) {
    _fail("Time " + timeSec + "s is outside the clip (" + _round(_sec(clip.start)) + "-" + _round(_sec(clip.end)) + "s). Keyframe times are sequence times.");
  }
  if (!prop.isTimeVarying()) prop.setTimeVarying(true, true);
  var t = _toMediaTime(clip, timeSec);
  if (!prop.keyExistsAtTime(t)) prop.addKey(t);
  prop.setValueAtKey(t, v, true);
  if (interpolation) {
    var mode = _interpModes[_norm(interpolation)];
    if (mode === undefined) _fail("interpolation must be linear, hold or bezier");
    prop.setInterpolationTypeAtKey(t, mode, true);
  }
  return { effect: comp.displayName, property: prop.displayName, time: timeSec, value: _plainValue(prop.getValueAtKey(t)), keyframes: _keyframesOf(prop, clip) };
}

function _keyAt(prop, clip, keyRef) {
  var keys = prop.getKeys();
  if (!keys || !keys.length) _fail("Property has no keyframes");
  if (keyRef && keyRef.index !== undefined && keyRef.index !== null) {
    if (keyRef.index < 0 || keyRef.index >= keys.length) _fail("Keyframe index out of range (0-" + (keys.length - 1) + ")");
    return keys[keyRef.index];
  }
  var best = null, bestDist = Infinity;
  for (var k = 0; k < keys.length; k++) {
    var d = Math.abs(_toSeqTime(clip, keys[k]) - keyRef.time);
    if (d < bestDist) { bestDist = d; best = keys[k]; }
  }
  if (bestDist > _frameDuration(_seq())) _fail("No keyframe at " + keyRef.time + "s");
  return best;
}

function removeKeyframe(trackType, trackIndex, clipIndex, effect, property, keyRef) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var prop = _getProperty(_getComponent(clip, effect), property);
  prop.removeKey(_keyAt(prop, clip, keyRef));
  return { keyframes: _keyframesOf(prop, clip) };
}

function clearKeyframes(trackType, trackIndex, clipIndex, effect, property) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var prop = _getProperty(_getComponent(clip, effect), property);
  var v = prop.getValue();
  prop.setTimeVarying(false, true);
  try { prop.setValue(v, true); } catch (ex) {}
  return { property: prop.displayName, value: _propValue(prop) };
}

function getKeyframes(trackType, trackIndex, clipIndex, effect, property) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var prop = _getProperty(_getComponent(clip, effect), property);
  return { property: prop.displayName, animated: prop.isTimeVarying(), keyframes: prop.isTimeVarying() ? _keyframesOf(prop, clip) : [] };
}

function setKeyframeInterpolation(trackType, trackIndex, clipIndex, effect, property, keyRef, interpolation) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var prop = _getProperty(_getComponent(clip, effect), property);
  var mode = _interpModes[_norm(interpolation)];
  if (mode === undefined) _fail("interpolation must be linear, hold or bezier");
  if (keyRef === "all" || (keyRef && keyRef.all)) {
    var keys = prop.getKeys();
    for (var k = 0; k < keys.length; k++) prop.setInterpolationTypeAtKey(keys[k], mode, true);
  } else {
    prop.setInterpolationTypeAtKey(_keyAt(prop, clip, keyRef), mode, true);
  }
  return { interpolation: _interpNames[mode] };
}

/* ---------- transitions ---------- */

function _transitionsOn(track) {
  var out = [];
  for (var i = 0; i < track.transitions.numItems; i++) {
    var tr = track.transitions[i];
    out.push({ index: i, name: tr.name || tr.matchName, start: _round(_sec(tr.start)), end: _round(_sec(tr.end)), duration: _round(_sec(tr.duration)) });
  }
  return out;
}

function getTransitions(trackType, trackIndex) {
  var seq = _seq();
  var out = [];
  var types = trackType ? [trackType] : ["video", "audio"];
  for (var k = 0; k < types.length; k++) {
    var tracks = _tracks(seq, types[k]);
    for (var t = 0; t < tracks.numTracks; t++) {
      if (_has(trackIndex) && trackIndex >= 0 && t !== trackIndex) continue;
      var list = _transitionsOn(tracks[t]);
      for (var i = 0; i < list.length; i++) {
        list[i].trackType = types[k];
        list[i].trackIndex = t;
        out.push(list[i]);
      }
    }
  }
  return out;
}

// position: "start" | "end" | "both"; alignment: "center" (on the cut),
// "start" (begins at the cut) or "end" (ends at the cut).
function applyTransition(trackType, trackIndex, clipIndex, transitionName, durationSec, position, alignment) {
  var kind = trackType === "video" ? "videoTransitions" : "audioTransitions";
  var name = _closestName(kind, transitionName || (trackType === "video" ? "Cross Dissolve" : "Constant Power"));
  var trans = trackType === "video" ? _qe().project.getVideoTransitionByName(name) : _qe().project.getAudioTransitionByName(name);
  var clip = _getClip(trackType, trackIndex, clipIndex);
  var dur = _has(durationSec) && durationSec > 0 ? durationSec : 1;
  if (dur > _sec(clip.duration)) dur = _sec(clip.duration);
  var align = { center: 0.5, start: 0, end: 1 }[alignment || "center"];
  if (align === undefined) align = 0.5;
  var sides = position === "both" ? ["start", "end"] : [position || "end"];
  _withFrameDisplay(function () {
    for (var s = 0; s < sides.length; s++) {
      var q = _qeClip(trackType, trackIndex, clipIndex);
      var atStart = sides[s] === "start";
      // At a cut "center" puts the transition across both clips; with no
      // neighbour it has to sit entirely on this clip.
      var a = align;
      if (a === 0.5 && !_hasNeighbour(trackType, trackIndex, clipIndex, atStart)) a = atStart ? 0 : 1;
      q.addTransition(trans, atStart, _framesString(dur), "0", a, false, true);
    }
  });
  return { transition: name, duration: dur, transitions: _transitionsOn(_getTrack(trackType, trackIndex)) };
}

function _hasNeighbour(trackType, trackIndex, clipIndex, atStart) {
  var track = _getTrack(trackType, trackIndex);
  var clip = track.clips[clipIndex];
  var edge = atStart ? _sec(clip.start) : _sec(clip.end);
  var fd = _frameDuration(_seq());
  for (var i = 0; i < track.clips.numItems; i++) {
    if (i === clipIndex) continue;
    var other = atStart ? _sec(track.clips[i].end) : _sec(track.clips[i].start);
    if (Math.abs(other - edge) < fd / 2) return true;
  }
  return false;
}

function removeTransition(trackType, trackIndex, transitionIndex) {
  var track = _getTrack(trackType, trackIndex);
  if (transitionIndex < 0 || transitionIndex >= track.transitions.numItems) _fail("Transition index out of range (track has " + track.transitions.numItems + ")");
  var tr = track.transitions[transitionIndex];
  var name = tr.name;
  tr.remove(false, false);
  return { removed: name, transitions: _transitionsOn(track) };
}

/* ---------- Motion / Opacity shortcuts ---------- */

// Position is in pixels from the top-left of the frame; anchor point in
// pixels of the clip. Premiere stores both normalized (0-1).
function setClipTransform(trackIndex, clipIndex, t) {
  var clip = _getClip("video", trackIndex, clipIndex);
  var seq = _seq();
  var w = seq.frameSizeHorizontal, h = seq.frameSizeVertical;
  var motion = _findComponent(clip, "Motion");
  var opacity = _findComponent(clip, "Opacity");
  var time = _has(t.time) && t.time >= 0 ? t.time : null;
  var changed = [];

  function apply(comp, propName, value) {
    var prop = _findProperty(comp, propName);
    if (!prop) _fail("'" + propName + "' not found on this clip");
    if (time !== null || prop.isTimeVarying()) {
      var at = time !== null ? time : _sec(seq.getPlayerPosition());
      if (!prop.isTimeVarying()) prop.setTimeVarying(true, true);
      var mt = _toMediaTime(clip, at);
      if (!prop.keyExistsAtTime(mt)) prop.addKey(mt);
      prop.setValueAtKey(mt, value, true);
    } else {
      prop.setValue(value, true);
    }
    changed.push(propName);
  }

  if (motion) {
    if (_has(t.x) || _has(t.y)) {
      var pos = _propValue(_findProperty(motion, "Position"));
      apply(motion, "Position", [_has(t.x) ? t.x / w : pos[0], _has(t.y) ? t.y / h : pos[1]]);
    }
    if (_has(t.scale)) {
      apply(motion, "Scale", t.scale);
    }
    if (_has(t.scaleWidth)) {
      _findProperty(motion, "Uniform Scale").setValue(false, true);
      apply(motion, "Scale Width", t.scaleWidth);
    }
    if (_has(t.uniformScale)) _findProperty(motion, "Uniform Scale").setValue(!!t.uniformScale, true);
    if (_has(t.rotation)) apply(motion, "Rotation", t.rotation);
    if (_has(t.anchorX) || _has(t.anchorY)) {
      var an = _propValue(_findProperty(motion, "Anchor Point"));
      apply(motion, "Anchor Point", [_has(t.anchorX) ? t.anchorX / w : an[0], _has(t.anchorY) ? t.anchorY / h : an[1]]);
    }
    var crops = { cropLeft: "Crop Left", cropTop: "Crop Top", cropRight: "Crop Right", cropBottom: "Crop Bottom" };
    for (var key in crops) if (_has(t[key])) apply(motion, crops[key], t[key]);
  }
  if (opacity && _has(t.opacity)) apply(opacity, "Opacity", t.opacity);
  if (opacity && _has(t.blendMode)) {
    var modes = { normal: 0, dissolve: 1, darken: 2, multiply: 3, "color burn": 4, "linear burn": 5, "darker color": 6, lighten: 7, screen: 8, "color dodge": 9, "linear dodge (add)": 10, add: 10, "lighter color": 11, overlay: 12, "soft light": 13, "hard light": 14, "vivid light": 15, "linear light": 16, "pin light": 17, "hard mix": 18, difference: 19, exclusion: 20, subtract: 21, divide: 22, hue: 23, saturation: 24, color: 25, luminosity: 26 };
    var m = typeof t.blendMode === "number" ? t.blendMode : modes[_norm(t.blendMode)];
    if (m === undefined) _fail("Unknown blend mode " + t.blendMode);
    _findProperty(opacity, "Blend Mode").setValue(m, true);
    changed.push("Blend Mode");
  }
  var result = getClipTransform(trackIndex, clipIndex);
  result.changed = changed;
  return result;
}

function getClipTransform(trackIndex, clipIndex) {
  var clip = _getClip("video", trackIndex, clipIndex);
  var seq = _seq();
  var w = seq.frameSizeHorizontal, h = seq.frameSizeVertical;
  var motion = _findComponent(clip, "Motion");
  var opacity = _findComponent(clip, "Opacity");
  var r = { frameSize: [w, h] };
  if (motion) {
    var pos = _propValue(_findProperty(motion, "Position"));
    var anc = _propValue(_findProperty(motion, "Anchor Point"));
    r.x = _round(pos[0] * w);
    r.y = _round(pos[1] * h);
    r.scale = _propValue(_findProperty(motion, "Scale"));
    r.uniformScale = _propValue(_findProperty(motion, "Uniform Scale"));
    if (!r.uniformScale) r.scaleWidth = _propValue(_findProperty(motion, "Scale Width"));
    r.rotation = _propValue(_findProperty(motion, "Rotation"));
    r.anchorX = _round(anc[0] * w);
    r.anchorY = _round(anc[1] * h);
    r.crop = [_propValue(_findProperty(motion, "Crop Left")), _propValue(_findProperty(motion, "Crop Top")), _propValue(_findProperty(motion, "Crop Right")), _propValue(_findProperty(motion, "Crop Bottom"))];
    var anim = [];
    for (var i = 0; i < motion.properties.numItems; i++) {
      try { if (motion.properties[i].isTimeVarying()) anim.push(motion.properties[i].displayName); } catch (ex) {}
    }
    if (anim.length) r.animated = anim;
  }
  if (opacity) {
    var op = _findProperty(opacity, "Opacity");
    r.opacity = _propValue(op);
    if (op.isTimeVarying()) {
      r.animated = r.animated || [];
      r.animated.push("Opacity");
    }
  }
  if (r.animated) r.note = "Animated properties show their base value; use get_keyframes for the animation.";
  return r;
}
