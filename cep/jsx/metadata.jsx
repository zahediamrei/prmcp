/* Project-item metadata (XMP and Premiere project columns) */

function getXMPMetadata(nodeId) {
  return { xmp: _getItem(nodeId).getXMPMetadata() };
}

function setXMPMetadata(nodeId, xmp) {
  _getItem(nodeId).setXMPMetadata(xmp);
  return {};
}

function getProjectColumns(nodeId) {
  var raw = _getItem(nodeId).getProjectColumnsMetadata();
  var parsed = JSON.parse(raw);
  var out = {};
  for (var i = 0; i < parsed.length; i++) {
    if (parsed[i].ColumnValue !== "" && parsed[i].ColumnValue !== undefined) out[parsed[i].ColumnName] = parsed[i].ColumnValue;
  }
  return out;
}

var _PPRO_SCHEMA = "http://ns.adobe.com/premierePrivateProjectMetaData/1.0/";

var _columnKeys = {
  "description": ["Column.PropertyString.Description", "Column.PropertyText.Description"],
  "log note": ["Column.Intrinsic.LogNote", "Column.PropertyString.LogNote"],
  "good": ["Column.PropertyBool.Good"],
};

// These columns live in the media's XMP (Dynamic Media schema).
var _XMPDM = "http://ns.adobe.com/xmp/1.0/DynamicMedia/";
var _xmpColumns = { "comment": "logComment", "scene": "scene", "shot": "shotName" };

function _xmpLib() {
  if (!ExternalObject.AdobeXMPScript) ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
}

// Writable Project panel columns: Description, Comment, Log Note, Scene, Shot, Good.
function setProjectColumn(nodeId, column, value) {
  var item = _getItem(nodeId);
  _xmpLib();
  var dm = _xmpColumns[_norm(column)];
  if (dm) {
    var meta = new XMPMeta(item.getXMPMetadata());
    meta.setProperty(_XMPDM, dm, String(value));
    item.setXMPMetadata(meta.serialize());
    return { column: column, value: String(value) };
  }
  var keys = _columnKeys[_norm(column)];
  if (!keys) _fail("Column must be one of: Description, Comment, Log Note, Scene, Shot, Good");
  var shown = _norm(column) === "log note" ? "Log Note" : column.charAt(0).toUpperCase() + column.slice(1).toLowerCase();
  for (var i = 0; i < keys.length; i++) {
    var xmp = new XMPMeta(item.getProjectMetadata());
    xmp.setProperty(_PPRO_SCHEMA, keys[i], String(value));
    item.setProjectMetadata(xmp.serialize(), [keys[i]]);
    var cols = getProjectColumns(nodeId);
    for (var k in cols) {
      if (_norm(k) === _norm(shown) && String(cols[k]) === String(value)) return { column: k, value: cols[k] };
    }
  }
  _fail("Premiere did not accept the value for column " + column);
}
