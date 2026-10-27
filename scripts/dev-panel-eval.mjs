// Development only: evaluate JavaScript inside the Premiere Connector panel (CEP debug port 8088).
import WebSocket from "ws";
const expr = process.argv[2];
const pages = await (await fetch("http://localhost:8088/json/list")).json();
const page = pages.find((p) => p.title === "Premiere Connector");
const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } })));
ws.on("message", (d) => { const m = JSON.parse(d); console.log(JSON.stringify(m.result?.result?.value ?? m, null, 1)); ws.close(); });
