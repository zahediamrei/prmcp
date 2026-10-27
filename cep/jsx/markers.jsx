/* Sequence markers and clip (source) markers */

var _markerColors = ["green", "red", "purple", "orange", "yellow", "white", "blue", "cyan"];

function _markerColorIndex(color) {
  if (typeof color === "number") return color;
  for (var i = 0; i < _markerColors.length; i++) if (_markerColors[i] === _norm(color)) return i;
  _fail("Unknown marker color '" + color + "'. Use one of: " + _markerColors.join(", "));
}

function _markerInfo(m, index, offset) {
  offset = offset || 0;
  var info = {
    index: index,
    name: m.name,
    start: _round(_sec(m.start) + offset),
    duration: _round(_sec(m.end) - _sec(m.start)),
    type: m.type,
    color: _markerColors[m.getColorByIndex()] || m.getColorByIndex(),
  };
  if (m.comments) info.comments = m.comments;
  if (m.type === "WebLink") {
    try { info.url = m.getWebLinkURL(); } catch (ex) {}
  }
  return info;
}

function _markerList(markers, offset) {
  var out = [];
  var m = markers.getFirstMarker();
  var i = 0;
  while (m) {
    out.push(_markerInfo(m, i++, offset));
    m = markers.getNextMarker(m);
  }
  return out;
}

function _markerAt(markers, index) {
  var m = markers.getFirstMarker();
  var i = 0;
  while (m) {
    if (i === index) return m;
    m = markers.getNextMarker(m);
    i++;
  }
  _fail("Marker " + index + " not found (there are " + i + ")");
}

function _applyMarkerProps(m, name, comment, color, durationSec, markerType, url) {
  if (_has(name)) m.name = name;
  if (_has(comment)) m.comments = comment;
  if (_has(color) && color !== "") m.setColorByIndex(_markerColorIndex(color));
  if (_has(durationSec) && durationSec >= 0) m.end = _sec(m.start) + durationSec;
  if (markerType) {
    var t = _norm(markerType);
    if (t === "chapter") m.setTypeAsChapter();
    else if (t === "segmentation") m.setTypeAsSegmentation();
    else if (t === "weblink") m.setTypeAsWebLink(url || "", "");
    else if (t === "comment") m.setTypeAsComment();
    else _fail("markerType must be comment, chapter, segmentation or weblink");
  }
}

function addMarker(timeSec, name, comment, color, durationSec, markerType, url) {
  var markers = _seq().markers;
  var m = markers.createMarker(timeSec);
  _applyMarkerProps(m, name, comment, color, durationSec, markerType, url);
  return _markerInfo(m, _indexOfMarker(markers, m));
}

function _indexOfMarker(markers, target) {
  var m = markers.getFirstMarker();
  var i = 0;
  while (m) {
    if (m.guid === target.guid) return i;
    m = markers.getNextMarker(m);
    i++;
  }
  return -1;
}

function addMarkers(list) {
  var markers = _seq().markers;
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    var m = markers.createMarker(d.time);
    _applyMarkerProps(m, d.name, d.comment, d.color, d.duration, d.type, d.url);
  }
  return { added: list.length, markers: _markerList(markers) };
}

function getMarkers() {
  return _markerList(_seq().markers);
}

function updateMarker(markerIndex, name, comment, color, durationSec, startSec) {
  var m = _markerAt(_seq().markers, markerIndex);
  if (_has(startSec) && startSec >= 0) {
    var dur = _sec(m.end) - _sec(m.start);
    m.start = startSec;
    m.end = startSec + dur;
  }
  _applyMarkerProps(m, name, comment, color, durationSec, null, null);
  return _markerInfo(m, _indexOfMarker(_seq().markers, m));
}

function removeMarker(markerIndex) {
  var markers = _seq().markers;
  var m = _markerAt(markers, markerIndex);
  var name = m.name;
  markers.deleteMarker(m);
  return { removed: name, remaining: markers.numMarkers };
}

function clearAllMarkers() {
  var markers = _seq().markers;
  var n = 0;
  var m = markers.getFirstMarker();
  while (m) {
    var next = markers.getNextMarker(m);
    markers.deleteMarker(m);
    n++;
    m = next;
  }
  return { removed: n };
}

// Clip markers live on the clip's source media, so times are converted
// between sequence time and media time.
function addClipMarker(trackType, trackIndex, clipIndex, timeSec, name, comment, color) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  if (!clip.projectItem) _fail("Clip has no source media");
  if (timeSec < _sec(clip.start) || timeSec > _sec(clip.end)) _fail("Time is outside the clip (" + _round(_sec(clip.start)) + "-" + _round(_sec(clip.end)) + "s)");
  var mediaTime = (_sec(clip.inPoint) + (timeSec - _sec(clip.start))) * (clip.getSpeed() || 1);
  var m = clip.projectItem.getMarkers().createMarker(mediaTime);
  _applyMarkerProps(m, name, comment, color, null, null, null);
  return { time: timeSec, mediaTime: _round(mediaTime), name: m.name };
}

function getClipMarkers(trackType, trackIndex, clipIndex) {
  var clip = _getClip(trackType, trackIndex, clipIndex);
  if (!clip.projectItem) return [];
  var speed = clip.getSpeed() || 1;
  var all = _markerList(clip.projectItem.getMarkers(), 0);
  for (var k = 0; k < all.length; k++) all[k].start = _round(_sec(clip.start) + all[k].start / speed - _sec(clip.inPoint));
  var out = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].start >= _sec(clip.start) - 1e-6 && all[i].start <= _sec(clip.end) + 1e-6) out.push(all[i]);
  }
  return out;
}

function addProjectItemMarker(nodeId, timeSec, name, comment, color, durationSec) {
  var item = _getItem(nodeId);
  var m = item.getMarkers().createMarker(timeSec);
  _applyMarkerProps(m, name, comment, color, durationSec, null, null);
  return _markerInfo(m, _indexOfMarker(item.getMarkers(), m));
}

function getProjectItemMarkers(nodeId) {
  return _markerList(_getItem(nodeId).getMarkers());
}
