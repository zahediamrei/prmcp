/* Playhead, source monitor, workspaces, undo and app info */

function setPlayhead(timeSec) {
  var seq = _seq();
  seq.setPlayerPosition(_secondsToTicks(timeSec));
  return { playhead: _round(_sec(seq.getPlayerPosition())) };
}

function getPlayhead() {
  return { playhead: _round(_sec(_seq().getPlayerPosition())) };
}

// Edit points (clip starts/ends) on unlocked tracks, sorted.
function _editPoints() {
  var pts = {};
  _forEachClip(_seq(), function (clip) {
    pts[_round(_sec(clip.start))] = true;
    pts[_round(_sec(clip.end))] = true;
  });
  var arr = [];
  for (var k in pts) arr.push(Number(k));
  arr.sort(function (a, b) { return a - b; });
  return arr;
}

function goToEdit(direction) {
  var seq = _seq();
  var now = _sec(seq.getPlayerPosition());
  var pts = _editPoints();
  var target = null;
  if (direction === "next") {
    for (var i = 0; i < pts.length; i++) if (pts[i] > now + 1e-3) { target = pts[i]; break; }
  } else {
    for (var j = pts.length - 1; j >= 0; j--) if (pts[j] < now - 1e-3) { target = pts[j]; break; }
  }
  if (target === null) return { playhead: _round(now), note: "No " + direction + " edit point" };
  return setPlayhead(target);
}

function playSequence(speed) {
  _seq();
  _qeSeq().player.play(speed || 1);
  return { playing: true };
}

function stopPlayback() {
  _seq();
  _qeSeq().player.stop();
  return { playing: false };
}

function openInSourceMonitor(nodeId) {
  var item = _getItem(nodeId);
  app.sourceMonitor.openProjectItem(item);
  return { opened: item.name };
}

function getSourceMonitor() {
  var item = app.sourceMonitor.getProjectItem();
  if (!item) return { open: false };
  return { open: true, name: item.name, nodeId: item.nodeId, position: _round(_sec(app.sourceMonitor.getPosition())) };
}

function getWorkspaces() {
  return app.getWorkspaces();
}

function setWorkspace(name) {
  var list = app.getWorkspaces();
  var found = null;
  for (var i = 0; i < list.length; i++) if (_norm(list[i]) === _norm(name)) found = list[i];
  if (!found) _fail("Workspace not found. Available: " + list.join(", "));
  app.setWorkspace(found);
  return { workspace: found };
}

function undo(steps) {
  var n = steps || 1;
  for (var i = 0; i < n; i++) _qe().project.undo();
  return { undone: n };
}

function redo(steps) {
  var n = steps || 1;
  for (var i = 0; i < n; i++) _qe().project.redo();
  return { redone: n };
}

function getAppVersion() {
  return { version: app.version, build: app.build, platform: $.os };
}

function getPaths() {
  return { appPath: app.path, userDocuments: Folder.myDocuments.fsName, temp: Folder.temp.fsName };
}
