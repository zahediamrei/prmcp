/* Project and project-panel functions */

function getProjectInfo() {
  var proj = _project();
  var open = [];
  for (var i = 0; i < app.projects.numProjects; i++) {
    open.push({ name: app.projects[i].name, path: app.projects[i].path });
  }
  return {
    name: proj.name,
    path: proj.path,
    numSequences: proj.sequences.numSequences,
    numRootItems: proj.rootItem.children.numItems,
    activeSequence: proj.activeSequence ? proj.activeSequence.name : null,
    openProjects: open,
  };
}

function saveProject() {
  _project().save();
  return { path: app.project.path };
}

function saveProjectAs(path) {
  _project().saveAs(path);
  return { path: path };
}

function openProject(path) {
  if (!new File(path).exists) _fail("File not found: " + path);
  var ok = app.openDocument(path, true, true, true, true);
  if (!ok) _fail("Premiere could not open " + path);
  return { path: path, name: app.project.name };
}

function newProject(path) {
  if (!/\.prproj$/i.test(path)) path += ".prproj";
  if (new File(path).exists) _fail("A project already exists at " + path);
  var ok = app.newProject(path);
  if (!ok) _fail("Could not create project at " + path);
  return { path: app.project.path, name: app.project.name };
}

function closeProject(save) {
  var proj = _project();
  var name = proj.name;
  if (save) proj.save();
  proj.closeDocument(save ? 1 : 0, 0);
  return { closed: name };
}

function importMedia(filePaths, targetBinPath, asNumberedStills) {
  var proj = _project();
  var bin = _getBin(targetBinPath || "");
  var missing = [];
  for (var i = 0; i < filePaths.length; i++) {
    if (!new File(filePaths[i]).exists && !new Folder(filePaths[i]).exists) missing.push(filePaths[i]);
  }
  if (missing.length) _fail("Files not found: " + missing.join(", "));
  var before = _nodeIdSet();
  proj.importFiles(filePaths, true, bin, !!asNumberedStills);
  var imported = [];
  for (var j = 0; j < filePaths.length; j++) {
    var item = _findItemByMediaPath(filePaths[j], before);
    imported.push(item ? { path: filePaths[j], name: item.name, nodeId: item.nodeId } : { path: filePaths[j], nodeId: null });
  }
  return { imported: imported };
}

function importSequences(projectPath, sequenceIds) {
  _project();
  if (!new File(projectPath).exists) _fail("Project not found: " + projectPath);
  var ok = (sequenceIds && sequenceIds.length)
    ? app.project.importSequences(projectPath, sequenceIds)
    : app.project.importFiles([projectPath], true, app.project.rootItem, false);
  return { imported: !!ok };
}

function getProjectItems(binPath, recursive) {
  return _collectItems(_getBin(binPath || ""), !!recursive, binPath || "");
}

function findProjectItems(query, type) {
  var results = [];
  var q = _norm(query);
  (function walk(root, path) {
    for (var i = 0; i < root.children.numItems; i++) {
      var item = root.children[i];
      var t = _itemTypeName(item);
      if ((type === "all" || type === t) && _norm(item.name).indexOf(q) >= 0) {
        results.push(_itemSummary(item, path));
      }
      if (item.type === ProjectItemType.BIN) walk(item, (path ? path + "/" : "") + item.name);
    }
  })(_project().rootItem, "");
  return results;
}

function getProjectItemInfo(nodeId) {
  var item = _getItem(nodeId);
  var info = _itemSummary(item);
  info.treePath = item.treePath;
  if (item.type === ProjectItemType.BIN) {
    info.numChildren = item.children.numItems;
    return info;
  }
  try { info.inPoint = _round(item.getInPoint().seconds); } catch (ex) {}
  try { info.outPoint = _round(item.getOutPoint().seconds); } catch (ex) {}
  try { info.frameRate = _round(1 / _ticksToSeconds(item.interpretedTimebase || item.sourceTimebase)); } catch (ex) {}
  try { info.colorLabel = _labelColors[item.getColorLabel()]; } catch (ex) {}
  try { info.hasProxy = item.hasProxy(); } catch (ex) {}
  try { if (item.hasProxy()) info.proxyPath = item.getProxyPath(); } catch (ex) {}
  try { info.isSequence = item.isSequence(); } catch (ex) {}
  try { info.isAdjustmentLayer = item.isAdjustmentLayer(); } catch (ex) {}
  try { info.isMulticamClip = item.isMulticamClip(); } catch (ex) {}
  try { info.isMergedClip = item.isMergedClip(); } catch (ex) {}
  try {
    var cols = item.getProjectColumnsMetadata();
    var parsed = JSON.parse(cols);
    for (var i = 0; i < parsed.length; i++) {
      var c = parsed[i];
      if (c.ColumnValue === "" || c.ColumnValue === undefined) continue;
      var key = c.ColumnName;
      if (/^(Media Duration|Media Start|Media End|Video Duration|Audio Duration)$/.test(key) && /^\d+$/.test(c.ColumnValue)) {
        info[key] = _round(_ticksToSeconds(c.ColumnValue));
      } else if (/^(Frame Rate|Video Info|Audio Info|Video Codec|Audio Codec|Capture Format)$/.test(key)) {
        info[key] = c.ColumnValue;
      }
    }
  } catch (ex) {}
  return info;
}

function createBin(name, parentBinPath) {
  var bin = _getBin(parentBinPath || "").createBin(name);
  if (!bin) _fail("Could not create bin " + name);
  return { name: bin.name, nodeId: bin.nodeId };
}

function renameProjectItem(nodeId, newName) {
  var item = _getItem(nodeId);
  if (item.type === ProjectItemType.BIN) item.renameBin(newName);
  else item.name = newName;
  return { nodeId: nodeId, name: item.name };
}

function deleteProjectItems(nodeIds) {
  var deleted = [];
  var notFound = [];
  for (var i = 0; i < nodeIds.length; i++) {
    var item = _findProjectItemByNodeId(_project().rootItem, nodeIds[i]);
    if (!item) {
      notFound.push(nodeIds[i]);
      continue;
    }
    var name = item.name;
    if (item.type === ProjectItemType.BIN) {
      item.deleteBin();
    } else {
      var seq = null;
      try { if (item.isSequence()) seq = _findSequenceByProjectItem(item); } catch (ex) {}
      if (seq) app.project.deleteSequence(seq);
      else {
        // Clips can only be removed through a temporary bin.
        var tmp = app.project.rootItem.createBin("__mcp_delete__");
        item.moveBin(tmp);
        tmp.deleteBin();
      }
    }
    deleted.push(name);
  }
  return { deleted: deleted, notFound: notFound };
}

function _findSequenceByProjectItem(item) {
  var seqs = app.project.sequences;
  for (var i = 0; i < seqs.numSequences; i++) {
    if (seqs[i].projectItem && seqs[i].projectItem.nodeId === item.nodeId) return seqs[i];
  }
  return null;
}

function moveProjectItem(nodeId, targetBinPath) {
  var item = _getItem(nodeId);
  item.moveBin(_getBin(targetBinPath || ""));
  return { nodeId: nodeId, bin: targetBinPath || "(root)" };
}

function setProjectItemInOut(nodeId, inPoint, outPoint) {
  var item = _getItem(nodeId);
  if (_has(inPoint) && inPoint >= 0) item.setInPoint(_secondsToTicks(inPoint), 4);
  if (_has(outPoint) && outPoint >= 0) item.setOutPoint(_secondsToTicks(outPoint), 4);
  return { inPoint: _round(item.getInPoint().seconds), outPoint: _round(item.getOutPoint().seconds) };
}

function clearProjectItemInOut(nodeId) {
  var item = _getItem(nodeId);
  item.clearInPoint();
  item.clearOutPoint();
  return {};
}

function createSubClip(nodeId, name, inPointSec, outPointSec, hardBoundaries) {
  var item = _getItem(nodeId);
  var sub = item.createSubClip(name, _secondsToTicks(inPointSec), _secondsToTicks(outPointSec), hardBoundaries ? 1 : 0, 1, 1);
  if (!sub) _fail("Could not create subclip");
  return { name: sub.name, nodeId: sub.nodeId };
}

function attachProxy(nodeId, proxyPath) {
  var item = _getItem(nodeId);
  if (!item.canProxy()) _fail("This item cannot have a proxy");
  item.attachProxy(proxyPath, 0);
  return { proxyPath: proxyPath };
}

function createProxy(nodeId, presetPath) {
  var item = _getItem(nodeId);
  if (!item.canProxy()) _fail("This item cannot have a proxy");
  var out = new File(item.getMediaPath()).parent.fsName;
  var job = app.encoder.encodeProjectItem(item, out + "/" + item.name + "_Proxy", presetPath, 0, true, true);
  app.encoder.startBatch();
  return { jobId: job, note: "Proxy render queued in Media Encoder; attach it with attach_proxy when finished." };
}

function toggleProxyMode(enable) {
  app.setEnableProxies(enable ? 1 : 0);
  return { proxiesEnabled: app.getEnableProxies() == 1 };
}

function refreshMedia(nodeId) {
  _getItem(nodeId).refreshMedia();
  return {};
}

function relinkMedia(nodeId, newPath) {
  var item = _getItem(nodeId);
  if (!new File(newPath).exists) _fail("File not found: " + newPath);
  if (!item.canChangeMediaPath()) _fail("This item cannot be relinked");
  item.changeMediaPath(newPath, true);
  return { mediaPath: item.getMediaPath() };
}

function importAEComps(aepPath, compNames, targetBinPath) {
  var bin = _getBin(targetBinPath || "");
  if (compNames && compNames.length) app.project.importAEComps(aepPath, compNames, bin);
  else app.project.importAllAEComps(aepPath, bin);
  return { aepPath: aepPath };
}

function consolidateDuplicates() {
  _project().consolidateDuplicates();
  return {};
}

function setScaleToFrameSize(nodeId) {
  _getItem(nodeId).setScaleToFrameSize();
  return {};
}

function setOverrideFrameRate(nodeId, frameRate) {
  _getItem(nodeId).setOverrideFrameRate(frameRate);
  return { frameRate: frameRate };
}

function setOverridePixelAspectRatio(nodeId, numerator, denominator) {
  _getItem(nodeId).setOverridePixelAspectRatio(numerator, denominator);
  return { pixelAspectRatio: numerator + ":" + denominator };
}

function setProjectItemLabel(nodeId, color) {
  var item = _getItem(nodeId);
  item.setColorLabel(_labelIndex(color));
  return { label: _labelColors[item.getColorLabel()] };
}

function setScratchDisks(path) {
  _project();
  var types = [ScratchDiskType.FirstVideoCaptureFolder, ScratchDiskType.FirstAudioCaptureFolder,
    ScratchDiskType.FirstVideoPreviewFolder, ScratchDiskType.FirstAudioPreviewFolder,
    ScratchDiskType.FirstAutoSaveFolder, ScratchDiskType.FirstCClibrariesFolder];
  for (var i = 0; i < types.length; i++) {
    try { app.project.setScratchDiskPath(path, types[i]); } catch (ex) {}
  }
  return { path: path };
}

function flushCache() {
  _qe().project.flushCache();
  return {};
}

function selectProjectItems(nodeIds) {
  var items = [];
  for (var i = 0; i < nodeIds.length; i++) items.push(_getItem(nodeIds[i]));
  var view = _activeProjectView();
  if (!view) _fail("The active project's Project panel is not open");
  app.setProjectViewSelection(items, view);
  return { selected: items.length };
}

function _activeProjectView() {
  var views = app.getProjectViewIDs();
  if (!views) return null;
  for (var v = 0; v < views.length; v++) {
    var p = app.getProjectFromViewID(views[v]);
    if (p && p.path === app.project.path) return views[v];
  }
  return null;
}

function getProjectPanelSelection() {
  var view = _activeProjectView();
  var out = [];
  if (!view) return out;
  var sel = app.getProjectViewSelection(view);
  if (sel) for (var i = 0; i < sel.length; i++) out.push(_itemSummary(sel[i]));
  return out;
}
