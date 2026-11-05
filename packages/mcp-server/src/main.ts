// Standalone entry: node packages/mcp-server/src/main.ts  (same as `fonino mcp`)
import { createDefaultRegistry } from "@agentphone/iphone-adapter";
import { startMcpServer } from "./index.ts";

await startMcpServer(createDefaultRegistry());
