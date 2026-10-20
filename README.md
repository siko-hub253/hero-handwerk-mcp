# HERO Handwerk MCP

**Connect Claude, ChatGPT, Cursor and other AI assistants to [HERO Handwerkersoftware](https://hero-software.de).**
Ask about customers, projects, quotes, invoices and appointments in plain language — and turn phone calls or emails into new HERO projects without typing.

> 🇩🇪 [Deutsche Kurzbeschreibung weiter unten](#deutsch)

> ⚠️ Unofficial, community-built integration. Not affiliated with or endorsed by HERO Software GmbH.

---

## What you can do

| Ask your assistant… | Tool used |
|---|---|
| "Which quotes for Frau Schmidt are still open?" | `hero_list_documents`, `hero_get_project` |
| "What appointments do we have tomorrow?" | `hero_list_appointments` |
| "Show me all projects in Hamburg in status *Angebot*." | `hero_list_projects` |
| "Find the customer number for Weber GmbH." | `hero_list_customers` |
| "What does 15mm copper pipe cost in our catalogue?" | `hero_list_products` |
| "Create a project for this email enquiry." | `hero_create_lead` *(write)* |
| "Add a note to project 4711: customer called, wants appointment next week." | `hero_add_logbook_entry` *(write)* |

Plus `hero_schema` and `hero_graphql` for anything else in the HERO API.

## Safety by default

- **Read-only unless you opt in.** Creating or changing data requires `HERO_ALLOW_WRITES=true`. In read-only mode even raw GraphQL mutations are refused.
- **Zero runtime dependencies.** The whole server is a few hundred lines of TypeScript you can audit in minutes.
- **Your data stays between you and HERO.** The server runs on your machine and talks only to the HERO API.

## Setup

### 1. Get a HERO API key
Ask HERO support for an API key (free for HERO customers). Keep it private — it gives access to your company data.

### 2. Build
```bash
git clone https://github.com/<your-user>/hero-handwerk-mcp.git
cd hero-handwerk-mcp
npm install
npm run build
```
Requires Node.js 18+.

### 3. Add to Claude Desktop
Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "hero": {
      "command": "node",
      "args": ["/absolute/path/to/hero-handwerk-mcp/dist/index.js"],
      "env": {
        "HERO_API_KEY": "your-api-key",
        "HERO_ALLOW_WRITES": "false"
      }
    }
  }
}
```
Restart Claude Desktop. Other MCP clients (Cursor, Windsurf, VS Code, …) use the same command and env.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `HERO_API_KEY` | — (required) | API key from HERO support |
| `HERO_ALLOW_WRITES` | `false` | `true` enables `hero_create_lead`, `hero_add_logbook_entry` and GraphQL mutations |
| `HERO_BASE_URL` | `https://login.hero-software.de` | API host |
| `HERO_TIMEOUT_MS` | `30000` | Request timeout |

## How it works

- Uses HERO's [GraphQL API](https://hero-software.de/api-doku/graphql-guide) (`/api/external/v7/graphql`) and [Lead API](https://hero-software.de/api-doku/lead-api) (`/api/v1/Projects/create`).
- Reads the HERO schema via introspection, so arguments are typed correctly and undocumented types (appointments, products) are queried automatically. Wrong filter names get a clear error listing the valid ones.

## Development

```bash
npm test   # builds and runs end-to-end tests against a mock HERO API
```

## Need it set up for your business?

Want an AI assistant that answers the phone, drafts quotes or keeps your HERO data clean — set up and tailored to your Betrieb? Open an issue or get in touch.

---

<a id="deutsch"></a>
## 🇩🇪 Deutsch

**Verbinden Sie Claude, ChatGPT & Co. mit Ihrer HERO Handwerkersoftware.**
Fragen Sie in normaler Sprache nach Kunden, Projekten, Angeboten, Rechnungen und Terminen — und legen Sie aus Anrufen oder E-Mails direkt neue Projekte in HERO an.

- *„Welche Angebote für Frau Schmidt sind noch offen?"*
- *„Welche Termine haben wir morgen?"*
- *„Leg für diese E-Mail-Anfrage ein Projekt an."*

**Sicher:** Standardmäßig nur Lesezugriff. Schreiben nur mit `HERO_ALLOW_WRITES=true`. Läuft lokal, Daten gehen nur an HERO.

**Einrichtung:** API-Schlüssel beim HERO-Support anfragen → Schritte oben unter *Setup* folgen.

Inoffizielle Community-Integration, nicht von der HERO Software GmbH.

**Einrichtung für Ihren Betrieb gewünscht?** Melden Sie sich gern — wir richten KI-Assistenten für Handwerksbetriebe ein.

## License

MIT
