import { WebSocketServer, WebSocket } from "ws";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
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

// A web page in a browser can open a WebSocket to localhost too, so both ends of every connection prove they hold this
// install's key: a random secret in a file only this user can read, which the panel and other copies of the server read
// and a web page can't. Same folder on both sides: the panel finds it through CEP's USER_DATA path.
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

// Both sides prove they hold the key without sending it: the server says hello with a random nonce, the client answers
// with its own nonce and an HMAC of both, and the server answers with an HMAC the other way round. Neither side acts on
// anything until it has checked the other's proof, so a program that grabbed the port first learns nothing and can't
// pass commands to the panel.
function proof(role: "client" | "server", a: string, b: string): string {
  return createHmac("sha256", KEY).update(`${role}:${a}:${b}`).digest("hex");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const HANDSHAKE_MS = 5000;

// Server side: the connection is handed on only once the client has proved it holds the key.
function greet(ws: WebSocket, ready: () => void) {
  const nonce = randomBytes(16).toString("hex");
  const timer = setTimeout(() => ws.close(4001, "No proof of key"), HANDSHAKE_MS);
  ws.send(JSON.stringify({ type: "hello", nonce }));
  ws.once("message", (data) => {
    clearTimeout(timer);
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      msg = {};
    }
    if (msg.type !== "auth" || typeof msg.nonce !== "string" || msg.nonce.length < 16 || !same(msg.proof, proof("client", nonce, msg.nonce))) {
      console.error("[Bridge] Refused a connection that doesn't hold this install's key");
      ws.close(4001, "Wrong key");
      return;
    }
    ws.send(JSON.stringify({ type: "welcome", proof: proof("server", msg.nonce, nonce) }));
    ready();
  });
}

function trustedOrigin(origin: string | undefined): boolean {
  // Pages on the web are refused before the handshake; everything else still has to prove it holds the key.
  return !(origin && /^https?:/i.test(origin));
}

function bind() {
  const server = new WebSocketServer({
    port: WS_PORT,
    host: "127.0.0.1",
    verifyClient: ({ origin }: { origin?: string }) => {
      const ok = trustedOrigin(origin || undefined);
      if (!ok) console.error(`[Bridge] Refused a connection from ${origin}`);
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
    const relay = !!req.url && req.url.startsWith(RELAY_PATH);
    greet(ws, () => (relay ? handleRelayClient(ws) : handlePanel(ws)));
  });
}

// Port taken by another server: talk to Premiere through it. If that server
// goes away, try to take over the port ourselves.
function connectRelay() {
  const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}${RELAY_PATH}`);
  // Client side of the handshake: answer the hello, then trust the owner only once its proof checks out.
  const mine = randomBytes(16).toString("hex");
  let theirs = "";
  let trustedOwner = false;
  const timer = setTimeout(() => ws.close(), HANDSHAKE_MS);
  ws.on("message", (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!trustedOwner) {
      if (msg.type === "hello" && !theirs && typeof msg.nonce === "string") {
        theirs = msg.nonce;
        ws.send(JSON.stringify({ type: "auth", nonce: mine, proof: proof("client", theirs, mine) }));
      } else if (msg.type === "welcome" && theirs && same(msg.proof, proof("server", mine, theirs))) {
        clearTimeout(timer);
        trustedOwner = true;
        relaySocket = ws;
        console.error(`[Bridge] Port ${WS_PORT} owned by another server; relaying through it`);
      } else {
        console.error("[Bridge] The program on port " + WS_PORT + " couldn't prove it holds this install's key");
        ws.close();
      }
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
