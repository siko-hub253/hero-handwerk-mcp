#!/usr/bin/env node
/**
 * hero-handwerk-mcp — connect AI assistants to HERO Handwerkersoftware.
 *
 * Environment:
 *   HERO_API_KEY       (required) API key from HERO support
 *   HERO_ALLOW_WRITES  "true" to allow creating leads / logbook entries (default: read-only)
 *   HERO_BASE_URL      default https://login.hero-software.de
 *   HERO_TIMEOUT_MS    default 30000
 */

import { HeroClient } from "./hero.js";
import { McpServer } from "./mcp.js";
import { registerTools } from "./tools.js";

const VERSION = "0.1.0";

function main(): void {
  const apiKey = process.env.HERO_API_KEY?.trim();
  if (!apiKey) {
    process.stderr.write(
      "hero-handwerk-mcp: HERO_API_KEY is not set. Request an API key from HERO support and add it to your MCP client config.\n",
    );
    process.exit(1);
  }
  const allowWrites = process.env.HERO_ALLOW_WRITES?.toLowerCase() === "true";
  const client = new HeroClient({
    apiKey,
    baseUrl: (process.env.HERO_BASE_URL ?? "https://login.hero-software.de").replace(/\/+$/, ""),
    timeoutMs: Number(process.env.HERO_TIMEOUT_MS ?? 30000),
  });

  const server = new McpServer(
    { name: "hero-handwerk-mcp", version: VERSION },
    [
      "Tools for HERO Handwerkersoftware (German trades/craft business software).",
      "Data is mostly in German: Angebot = quote, Rechnung = invoice, Auftrag = order, Termin = appointment, Projekt = job/project.",
      "Prefer the specific list/get tools; use hero_schema + hero_graphql only for things they don't cover.",
      allowWrites
        ? "Write access is ENABLED. Always confirm with the user before creating or changing data."
        : "Write access is DISABLED (read-only mode).",
    ].join(" "),
  );
  registerTools(server, client, { allowWrites });
  server.listen();
  process.stderr.write(`hero-handwerk-mcp ${VERSION} ready (${allowWrites ? "read/write" : "read-only"})\n`);
}

main();
