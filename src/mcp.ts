/**
 * Minimal, dependency-free MCP server over stdio.
 *
 * Implements the subset of the Model Context Protocol needed for a tools-only
 * server: initialize, ping, tools/list and tools/call. Messages are
 * newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs go to stderr only,
 * because stdout is reserved for protocol messages.
 */

import { createInterface } from "node:readline";

export type JsonSchema = Record<string, unknown>;

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export class McpServer {
  private tools = new Map<string, ToolDefinition>();

  constructor(
    private readonly info: { name: string; version: string },
    private readonly instructions?: string,
  ) {}

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  listTools(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Handle one parsed JSON-RPC message. Returns the response, or null for notifications. */
  async handle(msg: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      const result = await this.dispatch(msg);
      if (isNotification) return null;
      return { jsonrpc: "2.0", id: msg.id, result };
    } catch (err) {
      if (isNotification) return null;
      const e = err as { code?: number; message?: string };
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: e.code ?? -32603, message: e.message ?? String(err) },
      };
    }
  }

  private async dispatch(msg: JsonRpcRequest): Promise<unknown> {
    switch (msg.method) {
      case "initialize": {
        const requested = String(msg.params?.protocolVersion ?? "");
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
          ...(this.instructions ? { instructions: this.instructions } : {}),
        };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return {};
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: this.listTools().map(({ name, description, inputSchema, annotations }) => ({
            name,
            description,
            inputSchema,
            ...(annotations ? { annotations } : {}),
          })),
        };
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const tool = this.tools.get(name);
        if (!tool) throw { code: -32602, message: `Unknown tool: ${name}` };
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          return await tool.handler(args);
        } catch (err) {
          // Tool failures are reported as tool results so the model can see and react to them.
          return {
            content: [{ type: "text", text: `Error: ${(err as Error).message ?? String(err)}` }],
            isError: true,
          } satisfies ToolResult;
        }
      }
      default:
        throw { code: -32601, message: `Method not found: ${msg.method}` };
    }
  }

  /** Start reading JSON-RPC messages from stdin and writing responses to stdout. */
  listen(): void {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        this.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      const response = await this.handle(msg);
      if (response) this.write(response);
    });
    rl.on("close", () => process.exit(0));
  }

  private write(obj: unknown): void {
    process.stdout.write(JSON.stringify(obj) + "\n");
  }
}

export function text(value: unknown): ToolResult {
  const t = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: t }] };
}
