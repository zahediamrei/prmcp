import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFile } from "fs/promises";
import { join } from "path";
import { callPremiere, toolResult } from "../bridge.js";
import { loadConfig } from "../config.js";
import { outputDir, safeName } from "./common.js";

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

function apiKey(): string {
  const key = loadConfig().elevenlabs.api_key;
  if (!key) {
    throw new Error("No ElevenLabs API key. Put it in config.json (elevenlabs.api_key) or the ELEVENLABS_API_KEY environment variable.");
  }
  return key;
}

interface Voice {
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
}

async function tts(text: string, v: Voice, fileBase: string): Promise<string> {
  const cfg = loadConfig().elevenlabs;
  const voiceId = v.voiceId || cfg.default_voice_id;
  const settings: Record<string, any> = {
    stability: v.stability ?? 0.5,
    similarity_boost: v.similarityBoost ?? 0.75,
    style: v.style ?? 0,
    use_speaker_boost: true,
  };
  if (v.speed !== undefined) settings.speed = v.speed;
  const res = await fetch(`${ELEVENLABS_API}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey(), "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: v.modelId || cfg.default_model, voice_settings: settings }),
  });
  if (!res.ok) throw new Error(`ElevenLabs error ${res.status}: ${await res.text()}`);
  const file = join(await outputDir("voiceover"), `${safeName(fileBase)}_${Date.now()}.mp3`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

async function importAndPlace(file: string, trackIndex: number | undefined, start: number | undefined) {
  const imp = await callPremiere("importMedia", [[file], "", false]);
  const nodeId = imp.imported[0]?.nodeId;
  const out: any = { file, nodeId };
  if (nodeId && start !== undefined) {
    const placed = await callPremiere("overwriteClip", [nodeId, "audio", trackIndex ?? 1, start, null, null]);
    out.placed = placed.placed;
  }
  return out;
}

const voice = {
  voiceId: z.string().optional().describe("ElevenLabs voice ID (see elevenlabs_list_voices)"),
  modelId: z.string().optional().describe("Default eleven_multilingual_v2 (multilingual)"),
  stability: z.number().min(0).max(1).optional(),
  similarityBoost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.7).max(1.2).optional(),
};

export function registerAiTools(server: McpServer) {
  server.tool("elevenlabs_list_voices", "List the voices on your ElevenLabs account", {}, async () => {
    const res = await fetch(`${ELEVENLABS_API}/voices`, { headers: { "xi-api-key": apiKey() } });
    if (!res.ok) throw new Error(`ElevenLabs error ${res.status}`);
    const data = (await res.json()) as any;
    return toolResult(data.voices.map((v: any) => ({ voiceId: v.voice_id, name: v.name, category: v.category, labels: v.labels })));
  });

  server.tool(
    "elevenlabs_generate_speech",
    "Generate a voiceover with ElevenLabs, import it, and optionally place it on an audio track",
    {
      text: z.string(),
      ...voice,
      start: z.number().min(0).optional().describe("Place on the timeline at this time (seconds); omit to only import"),
      audioTrack: z.number().int().min(0).optional().describe("Audio track index (default 1 = A2)"),
    },
    async ({ text, start, audioTrack, ...v }) => {
      const file = await tts(text, v, text.slice(0, 30));
      return toolResult(await importAndPlace(file, audioTrack, start));
    }
  );

  server.tool(
    "elevenlabs_voice_lines",
    "Generate one voiceover clip per line and place each at its time (e.g. narration matching captions)",
    {
      lines: z.array(z.object({ text: z.string(), start: z.number().min(0) })).min(1),
      ...voice,
      audioTrack: z.number().int().min(0).optional().describe("Default 1 (A2)"),
    },
    async ({ lines, audioTrack, ...v }) => {
      const results = [];
      for (const [i, line] of lines.entries()) {
        try {
          const file = await tts(line.text, v, `line_${String(i + 1).padStart(2, "0")}_${line.text.slice(0, 20)}`);
          results.push({ text: line.text, ...(await importAndPlace(file, audioTrack, line.start)) });
        } catch (e: any) {
          results.push({ text: line.text, error: e.message });
        }
      }
      return toolResult({ audioTrack: audioTrack ?? 1, results });
    }
  );
}
