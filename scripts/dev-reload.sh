#!/usr/bin/env bash
# Development only: reload the Premiere Connector panel (and with it every JSX module)
# through the CEP remote-debugging port opened by cep/.debug.
cd "$(dirname "$0")/.." || exit 1
node --input-type=module -e '
import WebSocket from "ws";
const pages = await (await fetch("http://localhost:8088/json/list")).json();
const page = pages.find((p) => p.title === "Premiere Connector");
if (!page) { console.error("panel not found on debug port 8088"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "location.reload()" } })));
ws.on("message", () => { ws.close(); });
'
# Wait for the panel to reconnect to the dev bridge.
sleep 2
for i in $(seq 1 20); do
  curl -s localhost:8098/status | grep -q true && { echo reloaded; exit 0; }
  sleep 1
done
echo "panel did not reconnect"; exit 1
