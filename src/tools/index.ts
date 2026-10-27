import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConnectionTools } from "./connection.js";
import { registerProjectTools } from "./project.js";
import { registerSequenceTools } from "./sequence.js";
import { registerTimelineTools } from "./timeline.js";
import { registerEffectsTools } from "./effects.js";
import { registerMarkerTools } from "./markers.js";
import { registerAudioTools } from "./audio.js";
import { registerExportTools } from "./export.js";
import { registerMetadataTools } from "./metadata.js";
import { registerCaptionTools } from "./captions.js";
import { registerGraphicsTools } from "./graphics.js";
import { registerPlaybackTools } from "./playback.js";
import { registerScriptingTools } from "./scripting.js";
import { registerAiTools } from "./ai.js";
import { registerSafetyTools } from "./safety.js";
import { installSafety } from "../safety.js";

export function registerAllTools(server: McpServer) {
  installSafety(server); // must come first: it wraps every tool registered below
  registerConnectionTools(server);
  registerProjectTools(server);
  registerSequenceTools(server);
  registerTimelineTools(server);
  registerEffectsTools(server);
  registerMarkerTools(server);
  registerAudioTools(server);
  registerExportTools(server);
  registerMetadataTools(server);
  registerCaptionTools(server);
  registerGraphicsTools(server);
  registerPlaybackTools(server);
  registerScriptingTools(server);
  registerAiTools(server);
  registerSafetyTools(server);
}
