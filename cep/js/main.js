/* Premiere Connector panel: WebSocket client that relays MCP server commands to ExtendScript. */

var cs = new CSInterface();
var ws = null;
var WS_PORT = 8095;
var jsxReady = false;
var reconnectTimer = null;
var MAX_LOG_LINES = 200;

function log(msg) {
  var el = document.getElementById("log");
  var time = new Date().toLocaleTimeString();
  var lines = el.textContent.split("\n");
  if (lines.length > MAX_LOG_LINES) el.textContent = lines.slice(-MAX_LOG_LINES).join("\n");
  el.textContent += "[" + time + "] " + msg + "\n";
  el.scrollTop = el.scrollHeight;
}

function setStatus(text, className) {
  var el = document.getElementById("status");
  el.textContent = text;
  el.className = className;
}

// Escape every non-ASCII character so the script string survives the
// evalScript boundary intact (non-Latin text, emoji, etc.).
function toAsciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, function (c) {
    return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

// The key the server checks on every connection, from the file only this user can read (see KEY_FILE in bridge.ts).
function installKey() {
  var path = cs.getSystemPath(SystemPath.USER_DATA) + "/Premiere Connector/key";
  var r = window.cep.fs.readFile(path);
  if (r.err !== 0) return "";
  var k = String(r.data).replace(/\s+/g, "");
  return /^[0-9a-f]{64}$/.test(k) ? k : "";
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    connect();
  }, 3000);
}

function connect() {
  if (!jsxReady) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  setStatus("Waiting for Claude…", "connecting");
  // The server writes this install's key the first time it runs; until then there is nothing to connect to.
  var key = installKey();
  if (!key) { scheduleReconnect(); return; }
  var socket = new WebSocket("ws://127.0.0.1:" + WS_PORT + "/?key=" + key);
  ws = socket;

  socket.onopen = function () {
    if (ws !== socket) return;
    setStatus("Connected to Claude", "connected");
    log("Connected to MCP server");
  };

  socket.onclose = function () {
    if (ws !== socket) return;
    setStatus("Waiting for Claude…", "connecting");
    scheduleReconnect();
  };

  socket.onerror = function () {
    if (ws !== socket) return;
    scheduleReconnect();
  };

  socket.onmessage = function (event) {
    var msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      log("Bad message: " + e.message);
      return;
    }
    handleCommand(msg);
  };
}

function handleCommand(msg) {
  var args = msg.args || [];
  var script;
  if (msg.functionName === "executeScript") {
    script = "__mcpEval(" + toAsciiJson(String(args[0])) + ")";
  } else {
    script = "__mcpDispatch(" + toAsciiJson(msg.functionName) + ", " + toAsciiJson(toAsciiJson(args)) + ")";
  }
  log("← " + msg.functionName);
  cs.evalScript(script, function (result) {
    sendResponse(msg.id, msg.functionName, parseResult(result));
  });
}

function parseResult(result) {
  if (result === "EvalScript error.") {
    return { error: "ExtendScript engine error (the Premiere Connector scripts may not be loaded; reopen the panel)" };
  }
  if (result === undefined || result === "undefined" || result === "") return { success: true };
  try {
    return JSON.parse(result);
  } catch (e) {
    return { value: result };
  }
}

function sendResponse(id, name, result) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  var response = { id: id };
  if (result && typeof result === "object" && !(result instanceof Array) && result.error) {
    response.error = String(result.error);
    log("✗ " + name + ": " + response.error);
  } else {
    response.result = result;
  }
  ws.send(JSON.stringify(response));
}

function loadJSX() {
  var jsxPath = (cs.getSystemPath(SystemPath.EXTENSION) + "/jsx").replace(/\\/g, "/");
  var modules = [
    "json2-polyfill", "utils", "project", "sequence", "timeline", "effects",
    "markers", "audio", "export", "metadata", "captions", "graphics", "playback"
  ];

  cs.evalScript("1+1", function (probe) {
    if (probe !== "2") {
      setTimeout(loadJSX, 1500);
      return;
    }
    var idx = 0;
    var failed = [];
    (function loadNext() {
      if (idx >= modules.length) {
        if (failed.length) {
          setStatus("Script load failed: " + failed.join(", "), "disconnected");
          log("Failed to load: " + failed.join(", "));
          return;
        }
        jsxReady = true;
        log("Scripts loaded");
        connect();
        return;
      }
      var mod = modules[idx++];
      var file = jsxPath + "/" + mod + ".jsx";
      cs.evalScript("try{$.evalFile(" + toAsciiJson(file) + ");'ok'}catch(e){'ERR '+e.toString()+' line '+e.line}", function (r) {
        if (r !== "ok") {
          failed.push(mod);
          log(mod + ".jsx: " + r);
        }
        loadNext();
      });
    })();
  });
}

document.getElementById("reconnect").addEventListener("click", function () {
  if (!jsxReady) {
    loadJSX();
    return;
  }
  if (ws) {
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  connect();
});

setStatus("Starting…", "connecting");
loadJSX();

// The MCP server only listens while a Claude session is running, so keep
// polling; connect() is a no-op while a socket is open or connecting.
setInterval(connect, 5000);
