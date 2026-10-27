import { WebSocketServer, WebSocket } from "ws";
import { randomBytes, timingSafeEqual } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir, platform } from "os";
import { dirname, join } from "path";
import { loadConfig } from "./config.js";

const WS_PORT = loadConfig().port;
const DEFAULT_TIMEOUT_MS = 60_000;
const REBIND_MS = 3000;
const RELAY_PATH = "/relay";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

// Several Claude apps/windows each start their own server, but only one can
// own the port the panel connects to. That one is the owner; every other
// server connects to it as a relay and forwards its calls through it.
let cepSocket: WebSocket | null = null; // owner: the Premiere panel
const relayClients = new Set<WebSocket>(); // owner: other servers
let relaySocket: WebSocket | null = null; // relay: link to the owner
let ownerHasPanel = false; // relay: owner's last reported panel state

const pendingRequests = new Map<string, Pending>();
let requestId = 0;

function settle(msg: any) {
  const pending = pendingRequests.get(msg.id);
  if (!pending) return;
  pendingRequests.delete(msg.id);
  clearTimeout(pending.timer);
  if (msg.error) pending.reject(new Error(msg.error));
  else pending.resolve(msg.result);
}

function rejectAll(reason: string) {
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingRequests.delete(id);
  }
}

function broadcastStatus() {
  const msg = JSON.stringify({ type: "status", connected: panelConnected() });
  for (const ws of relayClients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

function panelConnected(): boolean {
  return cepSocket !== null && cepSocket.readyState === WebSocket.OPEN;
}

function handleRelayClient(ws: WebSocket) {
  relayClients.add(ws);
  ws.send(JSON.stringify({ type: "status", connected: panelConnected() }));
  ws.on("message", async (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    try {
      const result = await callPremiere(msg.functionName, msg.args || [], msg.timeoutMs);
      ws.send(JSON.stringify({ id: msg.id, result }));
    } catch (e: any) {
      ws.send(JSON.stringify({ id: msg.id, error: e?.message || String(e) }));
    }
  });
  ws.on("close", () => relayClients.delete(ws));
}

function handlePanel(ws: WebSocket) {
  console.error("[Bridge] Premiere panel connected");
  if (cepSocket && cepSocket !== ws) cepSocket.close();
  cepSocket = ws;
  broadcastStatus();

  ws.on("message", (data) => {
    try {
      settle(JSON.parse(data.toString()));
    } catch (e) {
      console.error("[Bridge] Bad message from panel:", e);
    }
  });

  ws.on("close", () => {
    if (cepSocket !== ws) return;
    console.error("[Bridge] Premiere panel disconnected");
    cepSocket = null;
    rejectAll("The Premiere Pro panel disconnected");
    broadcastStatus();
  });
}

// A web page in a browser can open a WebSocket to localhost too, so every connection must show this install's key: a
// random secret in a file only this user can read, which the panel and other copies of the server read and a web page
// can't. Same folder on both sides: the panel finds it through CEP's USER_DATA path.
const KEY_FILE = join(
  platform() === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "Premiere Connector",
  "key"
);

function installKey(): string {
  if (existsSync(KEY_FILE)) {
    const k = readFileSync(KEY_FILE, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(k)) return k;
  }
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  const k = randomBytes(32).toString("hex");
  writeFileSync(KEY_FILE, k, { mode: 0o600 });
  try {
    chmodSync(KEY_FILE, 0o600);
  } catch {}
  return k;
}

const KEY = installKey();

function keyOf(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "ws://127.0.0.1").searchParams.get("key") ?? "";
  } catch {
    return "";
  }
}

function trusted(url: string | undefined, origin: string | undefined): boolean {
  // Pages on the web are refused outright; everything else still needs the key.
  if (origin && /^https?:/i.test(origin)) return false;
  const given = Buffer.from(keyOf(url));
  const want = Buffer.from(KEY);
  return given.length === want.length && timingSafeEqual(given, want);
}

function bind() {
  const server = new WebSocketServer({
    port: WS_PORT,
    host: "127.0.0.1",
    verifyClient: ({ origin, req }: { origin?: string; req: { url?: string } }) => {
      const ok = trusted(req.url, origin || undefined);
      if (!ok) console.error(`[Bridge] Refused a connection without this install's key${origin ? ` (from ${origin})` : ""}`);
      return ok;
    },
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      try {
        server.close();
      } catch {}
      connectRelay();
    } else {
      console.error("[Bridge] WebSocket server error:", err);
    }
  });
  server.on("listening", () => console.error(`[Bridge] Listening for the Premiere panel on port ${WS_PORT}`));
  server.on("connection", (ws, req) => {
    if (req.url && req.url.startsWith(RELAY_PATH)) handleRelayClient(ws);
    else handlePanel(ws);
  });
}

// Port taken by another server: talk to Premiere through it. If that server
// goes away, try to take over the port ourselves.
function connectRelay() {
  const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}${RELAY_PATH}?key=${KEY}`);
  ws.on("open", () => {
    relaySocket = ws;
    console.error(`[Bridge] Port ${WS_PORT} owned by another server; relaying through it`);
  });
  ws.on("message", (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "status") ownerHasPanel = !!msg.connected;
    else settle(msg);
  });
  ws.on("error", () => {});
  ws.on("close", () => {
    if (relaySocket === ws) {
      relaySocket = null;
      ownerHasPanel = false;
      rejectAll("Lost the link to the Premiere bridge; try again");
    }
    setTimeout(bind, REBIND_MS);
  });
}

bind();

export function isConnected(): boolean {
  if (relaySocket) return relaySocket.readyState === WebSocket.OPEN && ownerHasPanel;
  return panelConnected();
}

export function getPort(): number {
  return WS_PORT;
}

export function callPremiere(functionName: string, args: any[] = [], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!isConnected()) {
      reject(
        new Error(
          "Premiere Pro is not connected. Open Premiere Pro and the panel Window > Extensions > Premiere Connector (it should say 'Connected to Claude')."
        )
      );
      return;
    }
    const id = String(++requestId);
    const timer = setTimeout(() => {
      if (pendingRequests.delete(id)) {
        reject(
          new Error(
            `Premiere Pro did not answer within ${Math.round(timeoutMs / 1000)}s (${functionName}). ` +
              "It may be busy or showing a dialog; check Premiere and try again."
          )
        );
      }
    }, relaySocket ? timeoutMs + 5000 : timeoutMs);
    pendingRequests.set(id, { resolve, reject, timer });
    // Undefined args (optional tool params) become null so positions are kept.
    const payload = { id, functionName, args: args.map((a) => (a === undefined ? null : a)) };
    if (relaySocket) {
      // The owner applies the timeout; ours above is a few seconds longer as a backstop.
      relaySocket.send(JSON.stringify({ ...payload, timeoutMs }));
    } else {
      cepSocket!.send(JSON.stringify(payload));
    }
  });
}

export function toolResult(result: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

// Shorthand used by most tools: call a JSX function and wrap the result.
export async function run(functionName: string, args: any[] = [], timeoutMs?: number) {
  return toolResult(await callPremiere(functionName, args, timeoutMs));
}
