#!/usr/bin/env node
// Development helper: stands in for the MCP server on the panel's WebSocket
// port and exposes an HTTP endpoint for sending commands to Premiere.
//
//   node scripts/dev-bridge.mjs            # start (keep running)
//   curl -s localhost:8098/eval --data-binary 'app.version'
//   curl -s localhost:8098/call -d '{"fn":"getProjectInfo","args":[]}'
import { WebSocketServer } from "ws";
import http from "http";

const WS_PORT = Number(process.env.PPRO_MCP_PORT || 8095);
const HTTP_PORT = Number(process.env.DEV_HTTP_PORT || 8098);

let panel = null;
let nextId = 0;
const pending = new Map();

function bind() {
  const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });
  wss.on("error", (e) => {
    if (e.code !== "EADDRINUSE") throw e;
    wss.close();
    setTimeout(bind, 1000);
  });
  wss.on("listening", () => console.log("ws listening"));
  wss.on("connection", onConnection);
}
bind();

function onConnection(ws) {
  panel = ws;
  console.log("panel connected");
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
  });
  ws.on("close", () => {
    if (panel === ws) panel = null;
    console.log("panel disconnected");
  });
}

function send(functionName, args) {
  return new Promise((resolve) => {
    if (!panel) return resolve({ error: "panel not connected" });
    const id = String(++nextId);
    pending.set(id, resolve);
    panel.send(JSON.stringify({ id, functionName, args }));
    setTimeout(() => {
      if (pending.delete(id)) resolve({ error: "timeout" });
    }, 120000);
  });
}

http
  .createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    let out;
    if (req.url === "/status") out = { connected: !!panel };
    else if (req.url === "/eval") out = await send("executeScript", [body]);
    else if (req.url === "/call") {
      const { fn, args } = JSON.parse(body);
      out = await send(fn, args || []);
    } else out = { error: "unknown route" };
    res.end(JSON.stringify(out, null, 2) + "\n");
  })
  .listen(HTTP_PORT, "127.0.0.1", () => console.log(`dev bridge: ws ${WS_PORT}, http ${HTTP_PORT}`));
