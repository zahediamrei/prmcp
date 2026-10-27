#!/usr/bin/env node
// Development helper: one long-lived MCP client session over the real server,
// driven over HTTP so tool calls can be scripted step by step.
//   node scripts/mcp-shell.mjs            (keep running)
//   curl -s localhost:8199 -d '{"tool":"get_status","args":{}}'   (MCP_SHELL_PORT sets the port)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "mcp-shell", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "server.js")] }));

http
  .createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    try {
      const { tool, args } = JSON.parse(body);
      const r = await client.callTool({ name: tool, arguments: args ?? {} }, undefined, { timeout: 3_600_000 });
      const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const images = r.content.filter((c) => c.type === "image").length;
      res.end(JSON.stringify({ isError: !!r.isError, images, text }) + "\n");
    } catch (e) {
      res.end(JSON.stringify({ isError: true, text: String(e) }) + "\n");
    }
  })
  .listen(Number(process.env.MCP_SHELL_PORT || 8199), "127.0.0.1", () => console.log("mcp-shell on", process.env.MCP_SHELL_PORT || 8199));
