// Mock Premiere for tests: a mock DOM in a vm context running the panel's real JSX files,
// connected to the MCP server over the real WebSocket handshake.
import vm from "vm";
import fs from "fs";
import crypto from "crypto";

import { fileURLToPath } from "url";
import { dirname } from "path";
import { WebSocket } from "ws";
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const TPS = 254016000000;
let nextNode = 1000;
let nextSeq = 1;

export function build() {
  const ProjectItemType = { CLIP: 1, BIN: 2, ROOT: 3, FILE: 4 };
  const coll = (arr, key) => {
    Object.defineProperty(arr, key, { get: () => arr.length });
    return arr;
  };
  function Time() { this.ticks = "0"; }
  Object.defineProperty(Time.prototype, "seconds", { get() { return Number(this.ticks) / TPS; } });
  const T = (s) => { const t = new Time(); t.ticks = String(Math.round(s * TPS)); return t; };
  const sec = (t) => Number(t.ticks) / TPS;

  function makeBin(name, parent) {
    const bin = {
      name, parent, type: parent ? ProjectItemType.BIN : ProjectItemType.ROOT,
      children: coll([], "numItems"),
      createBin(n) { const b = makeBin(n, bin); bin.children.push(b); return b; },
    };
    return bin;
  }
  const root = makeBin("Proj.prproj", null);

  function binPath(bin) {
    const parts = [];
    for (let b = bin; b && b.parent; b = b.parent) parts.unshift(b.name);
    return parts;
  }

  class Clip {
    constructor(track, name, start, end, inSec) {
      this.track = track;
      this.nodeId = String(nextNode++);
      this.name = name;
      this.start = T(start);
      this.end = T(end);
      this.inPoint = T(inSec);
      this.disabled = false;
      this.speed = 1;
    }
    get duration() { return T(sec(this.end) - sec(this.start)); }
    getSpeed() { return this.speed; }
    move(t) { const d = sec(t); this.start = T(sec(this.start) + d); this.end = T(sec(this.end) + d); this.track.sort(); }
    remove(ripple) {
      const arr = this.track.clips;
      const i = arr.indexOf(this);
      arr.splice(i, 1);
      if (ripple) { const d = sec(this.end) - sec(this.start); for (const c of arr) if (sec(c.start) >= sec(this.end) - 1e-6) c.move(T(-d)); }
    }
  }
  class Track {
    constructor() { this.clips = coll([], "numItems"); }
    isLocked() { return false; }
    add(name, s, e, i = 0) { const c = new Clip(this, name, s, e, i); this.clips.push(c); this.sort(); return c; }
    sort() { this.clips.sort((a, b) => sec(a.start) - sec(b.start)); }
    razor(t) {
      for (const c of [...this.clips]) {
        if (sec(c.start) < t - 1e-6 && sec(c.end) > t + 1e-6) {
          const right = new Clip(this, c.name, t, sec(c.end), sec(c.inPoint) + (t - sec(c.start)));
          c.end = T(t);
          this.clips.push(right);
        }
      }
      this.sort();
    }
  }

  const project = {
    rootItem: root,
    sequences: coll([], "numSequences"),
    activeSequence: null,
    openSequence(id) { this.activeSequence = this.sequences.find((s) => s.sequenceID === id) || this.activeSequence; return true; },
    deleteSequence(seq) {
      const i = this.sequences.indexOf(seq);
      if (i >= 0) this.sequences.splice(i, 1);
      const b = seq.projectItem.bin.children; b.splice(b.indexOf(seq.projectItem), 1);
      if (this.activeSequence === seq) this.activeSequence = this.sequences[0] || null;
      return true;
    },
  };

  function makeSeq(name, bin, video, audio) {
    const seq = {
      name, sequenceID: "seq-" + nextSeq++, timebase: String(TPS / 25),
      videoTracks: coll(video, "numTracks"), audioTracks: coll(audio, "numTracks"),
      get end() { let e = 0; for (const t of [...this.videoTracks, ...this.audioTracks]) for (const c of t.clips) e = Math.max(e, sec(c.end)); return T(e); },
      getSettings() { return { videoFrameWidth: 1920, videoFrameHeight: 1080 }; },
      clone() {
        const v = video.map((t) => copyTrack(t)), a = audio.map((t) => copyTrack(t));
        makeSeq(seq.name + " Copy", seq.projectItem.bin, v, a);
        return true;
      },
    };
    seq.projectItem = {
      type: ProjectItemType.CLIP, bin,
      get name() { return seq.name; },
      get treePath() { return "\\" + ["Proj.prproj", ...binPath(this.bin), seq.name].join("\\"); },
      moveBin(b) { const c = this.bin.children; c.splice(c.indexOf(this), 1); this.bin = b; b.children.push(this); },
      isSequence() { return true; },
    };
    bin.children.push(seq.projectItem);
    project.sequences.push(seq);
    return seq;
  }
  function copyTrack(t) {
    const n = new Track();
    for (const c of t.clips) { const k = n.add(c.name, sec(c.start), sec(c.end), sec(c.inPoint)); k.speed = c.speed; k.disabled = c.disabled; }
    return n;
  }

  // Timeline: V1 intro 0-10, interview 10-30; A1 matching audio; A2 music 0-40
  const v1 = new Track(), a1 = new Track(), a2 = new Track();
  v1.add("intro", 0, 10); v1.add("interview", 10, 30, 5);
  a1.add("intro", 0, 10); a1.add("interview", 10, 30, 5);
  a2.add("music", 0, 40);
  const main = makeSeq("Main", root, [v1], [a1, a2]);
  project.activeSequence = main;

  const ctx = { app: { project, enableQE() {}, path: "/" }, Time, ProjectItemType, console };
  ctx.$ = { global: ctx };
  vm.createContext(ctx);
  for (const f of ["json2-polyfill", "utils", "project", "sequence", "timeline", "playback", "safety"]) {
    vm.runInContext(fs.readFileSync(`${REPO}/cep/jsx/${f}.jsx`, "utf8"), ctx, { filename: f + ".jsx" });
  }
  // QE isn't mocked: razors go straight to the mock tracks.
  ctx.razorAllTracks = (t) => {
    const s = project.activeSequence;
    for (const tr of [...s.videoTracks, ...s.audioTracks]) tr.razor(t);
    return { cutAt: t };
  };
  // An edit that breaks halfway, to test rollback.
  ctx.slideClip = () => {
    const s = project.activeSequence;
    s.videoTracks[0].clips.splice(0, 1);
    throw new Error("simulated failure halfway through the edit");
  };
  // A manual edit made in Premiere's UI.
  const manualEdit = () => { project.activeSequence.audioTracks[1].clips[0].end = T(35); };
  return { ctx, project, manualEdit };
}

export function connectPanel(port, keyFile, ctx) {
  const key = fs.readFileSync(keyFile, "utf8").trim();
  const hmac = (m) => crypto.createHmac("sha256", key).update(m).digest("hex");
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const mine = crypto.randomBytes(16).toString("hex");
    let theirs = "", trusted = false;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (!trusted) {
        if (msg.type === "hello") { theirs = msg.nonce; ws.send(JSON.stringify({ type: "auth", nonce: mine, proof: hmac(`client:${theirs}:${mine}`) })); }
        else if (msg.type === "welcome" && msg.proof === hmac(`server:${mine}:${theirs}`)) { trusted = true; resolve(ws); }
        return;
      }
      // Same path as the real panel: __mcpDispatch, then parseResult/sendResponse.
      const raw = ctx.__mcpDispatch(msg.functionName, JSON.stringify(msg.args || []));
      let result = raw === "" || raw === undefined ? { success: true } : JSON.parse(raw);
      const res = { id: msg.id };
      if (result && typeof result === "object" && !Array.isArray(result) && result.error) res.error = String(result.error);
      else res.result = result;
      ws.send(JSON.stringify(res));
    });
  });
}
