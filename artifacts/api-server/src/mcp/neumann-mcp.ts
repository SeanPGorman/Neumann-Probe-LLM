/**
 * Neumann-Probe stdio MCP server.
 *
 * Exposes the game tools to the headless Claude brain. By default that is the
 * SAME full set the OpenAI brain uses; when the operator opts into the fence
 * (VNG_SAFE_ONLY), both brains are limited to the SAFE tools. Reads VNG_API_KEY,
 * VNG_SAFE_ONLY, and optional VNG_PROBE_ID from its own process env; the Claude
 * CLI injects these via the --mcp-config file.
 *
 * VNG_PROBE_ID scopes every tool call to the probe the operator selected in the
 * UI. It arrives via env rather than a tool argument on purpose: the brain
 * cannot see or override it, so it cannot address a probe the operator didn't
 * pick. Unset means the operator's main probe.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, executeTool } from "../routes/vng/tools.js";
import { afterTool } from "../routes/vng/after-tool.js";
import {
  allowedTools,
  isToolAllowed,
  assertPolicyCoversTools,
} from "../routes/vng/tool-policy.js";

// Fail fast if the classification drifted from the tool list.
assertPolicyCoversTools();

// The tools this server will list and dispatch under the current fence setting.
const EXPOSED_TOOLS = allowedTools(TOOLS);
const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));

// Parsed the same way /command does (Number(); null = main probe). The CLI
// spawns a fresh subprocess per order, so resolving once is safe.
const PROBE_ID =
  process.env.VNG_PROBE_ID != null ? Number(process.env.VNG_PROBE_ID) : null;

const server = new Server(
  { name: "neumann", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: EXPOSED_TOOLS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: (t.function.parameters ?? {
      type: "object",
      properties: {},
    }) as any,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  if (!TOOL_NAMES.has(name)) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  }

  // The real fence: reject anything outside the allowed set even if a client
  // somehow asks for it (a broader --allowedTools, a stale name, etc.).
  if (!isToolAllowed(name)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Tool not permitted: ${name} (VNG_SAFE_ONLY is enabled).`,
        },
      ],
    };
  }

  try {
    const result = await executeTool(name, args, PROBE_ID);
    // Same UI bookkeeping the OpenAI brain does — shared so both stay in sync.
    // afterTool never throws; a bookkeeping failure won't fail the tool call.
    await afterTool(name, args, result, PROBE_ID);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: err?.message ?? String(err) }),
        },
      ],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is the MCP JSON-RPC channel.
  console.error(`[neumann-mcp] ready — ${EXPOSED_TOOLS.length} tools exposed`);
}

main().catch((err) => {
  console.error("[neumann-mcp] fatal:", err);
  process.exit(1);
});
