/* Captions: Premiere builds caption tracks from caption files (the MCP
   server writes the .srt). Caption tracks can't be read back by script. */

var _captionFormats = {
  subtitle: 0, cea608: 1, cea708: 2, teletext: 3, ebu: 65539, op42: 131075, op47: 196611,
};

function createCaptionTrack(captionFilePath, startSec, format) {
  var seq = _seq();
  if (!new File(captionFilePath).exists) _fail("Caption file not found: " + captionFilePath);
  var fmt = _captionFormats[_norm(format || "subtitle")];
  if (fmt === undefined) _fail("format must be one of: subtitle, cea608, cea708, teletext, ebu, op42, op47");

  var bin = _findBinByPath("Captions") || _project().rootItem.createBin("Captions");
  var before = _nodeIdSet();
  _project().importFiles([captionFilePath], true, bin, false);
  var item = _findItemByMediaPath(captionFilePath, before);
  if (!item) _fail("Could not import " + captionFilePath);
  var ok = seq.createCaptionTrack(item, startSec || 0, fmt);
  if (!ok) _fail("Premiere could not create the caption track");
  return { captionItem: item.name, nodeId: item.nodeId, format: format || "subtitle" };
}
