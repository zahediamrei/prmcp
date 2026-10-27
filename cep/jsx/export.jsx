/* Export and render functions */

var _ranges = { entire: 0, inout: 1, workarea: 2 };

function _rangeCode(range) {
  var r = _ranges[_norm(range || "entire").replace(/[^a-z]/g, "")];
  if (r === undefined) _fail("range must be entire, inOut or workArea");
  return [app.encoder.ENCODE_ENTIRE, app.encoder.ENCODE_IN_TO_OUT, app.encoder.ENCODE_WORKAREA][r];
}

function _ensureFolder(path) {
  var folder = new File(path).parent;
  if (!folder.exists && !folder.create()) _fail("Cannot create folder " + folder.fsName);
}

function _checkPreset(presetPath) {
  if (!presetPath || !new File(presetPath).exists) _fail("Export preset not found: " + presetPath + " (use get_export_presets)");
}

// Renders inside Premiere and returns when the file is written.
function exportSequence(outputPath, presetPath, range, sequenceNameOrId) {
  var seq = sequenceNameOrId ? _getSequence(sequenceNameOrId) : _seq();
  _checkPreset(presetPath);
  _ensureFolder(outputPath);
  var result = seq.exportAsMediaDirect(outputPath, presetPath, _rangeCode(range));
  if (result && result !== "No Error") _fail("Export failed: " + result);
  var ext = seq.getExportFileExtension(presetPath);
  var path = outputPath;
  if (!new File(path).exists && ext && new File(outputPath + "." + ext).exists) path = outputPath + "." + ext;
  return { outputPath: path, exists: new File(path).exists };
}

// Queues the export in Adobe Media Encoder (Premiere stays usable).
function queueExport(outputPath, presetPath, range, startImmediately, sequenceNameOrId) {
  var seq = sequenceNameOrId ? _getSequence(sequenceNameOrId) : _seq();
  _checkPreset(presetPath);
  _ensureFolder(outputPath);
  app.encoder.launchEncoder();
  var jobId = app.encoder.encodeSequence(seq, outputPath, presetPath, _rangeCode(range), 1);
  if (startImmediately !== false) app.encoder.startBatch();
  return { jobId: jobId, outputPath: outputPath, note: "Rendering in Adobe Media Encoder." };
}

// One frame through a real render (effects and keyframes included).
function exportFrame(timeSec, outputPath, pngPresetPath) {
  var seq = _seq();
  _checkPreset(pngPresetPath);
  _ensureFolder(outputPath);
  var fd = Number(seq.timebase);
  var t = timeSec >= 0 ? timeSec : _sec(seq.getPlayerPosition());
  var frameTicks = Math.floor(Number(_secondsToTicks(t)) / fd) * fd;
  var oldIn = seq.getInPointAsTime().ticks;
  var oldOut = seq.getOutPointAsTime().ticks;
  var base = outputPath.replace(/\.png$/i, "");
  var produced = new File(base + "0.png");
  if (produced.exists) produced.remove();
  try {
    seq.setInPoint(String(frameTicks));
    seq.setOutPoint(String(frameTicks + fd));
    var result = seq.exportAsMediaDirect(base + ".png", pngPresetPath, app.encoder.ENCODE_IN_TO_OUT);
    if (result && result !== "No Error") _fail("Frame export failed: " + result);
  } finally {
    seq.setInPoint(oldIn);
    seq.setOutPoint(oldOut);
  }
  var target = new File(base + ".png");
  if (produced.exists) {
    if (target.exists) target.remove();
    produced.rename(target.name);
  }
  if (!target.exists) _fail("Frame was not written");
  return { outputPath: target.fsName, time: _round(frameTicks / TICKS_PER_SECOND) };
}

function exportFinalCutXML(outputPath) {
  _ensureFolder(outputPath);
  _seq().exportAsFinalCutProXML(outputPath, 1);
  return { outputPath: outputPath };
}

function exportAAF(outputPath, mixdownAudio, explodeToMono, sampleRate, bitsPerSample) {
  _ensureFolder(outputPath);
  app.project.exportAAF(_seq(), outputPath, mixdownAudio ? 1 : 0, explodeToMono ? 1 : 0, sampleRate || 48000, bitsPerSample || 16, 1, 0, 0, 0);
  return { outputPath: outputPath };
}

function exportOMF(outputPath, sampleRate, bitsPerSample, handleFrames) {
  _ensureFolder(outputPath);
  app.project.exportOMF(_seq(), outputPath, _seq().name, sampleRate || 48000, bitsPerSample || 16, 1, 0, handleFrames || 0, 0);
  return { outputPath: outputPath };
}

function exportProjectWithSequence(outputPath) {
  _ensureFolder(outputPath);
  _seq().exportAsProject(outputPath);
  return { outputPath: outputPath };
}

function renderPreviews(range) {
  var q = _qeSeq();
  if (_norm(range) === "all") q.renderAll();
  else q.renderPreview();
  return { note: "Rendering previews in Premiere Pro." };
}
