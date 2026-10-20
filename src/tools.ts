import type { HeroClient } from "./hero.js";
import { text, type McpServer, type ToolResult } from "./mcp.js";
import { SchemaCache, namedType, runRootField, typeRefToString } from "./schema.js";

export interface ToolOptions {
  allowWrites: boolean;
}

// Selection sets taken from HERO's public API guide.
const CONTACT_FIELDS = `id nr first_name last_name company_name email phone_home address { street city zipcode }`;
const PROJECT_SUMMARY_FIELDS = `id project_nr
  measure { short name }
  customer { id first_name last_name email }
  address { street city zipcode }
  current_project_match_status { status_code name }`;
const PROJECT_DETAIL_FIELDS = `${PROJECT_SUMMARY_FIELDS}
  contact { id first_name last_name email }
  customer_documents { type nr value created file_upload { url } }
  histories { custom_title custom_text created }`;
const DOCUMENT_FIELDS = `id created nr value vat status_code document_type { base_type name } file_upload { url }`;

const offsetProp = {
  offset: { type: "integer", minimum: 0, default: 0, description: "Pagination offset (HERO returns results in pages)." },
};
const filtersProp = {
  filters: {
    type: "object",
    additionalProperties: true,
    description:
      "Optional extra GraphQL arguments passed straight to HERO (e.g. date ranges). Call hero_schema first to see which arguments this query accepts.",
  },
};

function matches(obj: unknown, needle: string): boolean {
  return JSON.stringify(obj ?? "").toLowerCase().includes(needle.toLowerCase());
}

function writeGuard(opts: ToolOptions): void {
  if (!opts.allowWrites) {
    throw new Error(
      "Write access is disabled. Set HERO_ALLOW_WRITES=true in the server configuration to let the assistant create or change data in HERO.",
    );
  }
}

function isMutation(doc: string): boolean {
  const stripped = doc.replace(/#[^\n]*/g, "").replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"/g, '""');
  return /\bmutation\b/i.test(stripped);
}

export function registerTools(server: McpServer, client: HeroClient, opts: ToolOptions): void {
  const schema = new SchemaCache(client);

  // ---------------------------------------------------------------- Read tools

  server.register({
    name: "hero_list_customers",
    description:
      "List contacts from HERO (customers by default). Use `search` to filter the returned page by name, company, email, phone or address. Returns id, customer number, name, company, email, phone and address.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", default: "customer", description: 'Contact category, e.g. "customer".' },
        search: { type: "string", description: "Case-insensitive text filter applied to the results." },
        ...offsetProp,
        ...filtersProp,
      },
    },
    annotations: { title: "List customers", readOnlyHint: true, openWorldHint: true },
    handler: async (a) => {
      const args = { category: a.category ?? "customer", orderBy: "id", offset: a.offset ?? 0, ...(a.filters as object) };
      let rows = (await runRootField(client, schema, "query", "contacts", args, CONTACT_FIELDS)) as unknown[];
      if (typeof a.search === "string" && a.search.trim() && Array.isArray(rows)) {
        rows = rows.filter((r) => matches(r, a.search as string));
      }
      return text({ count: Array.isArray(rows) ? rows.length : undefined, offset: args.offset, results: rows });
    },
  });

  server.register({
    name: "hero_list_projects",
    description:
      "List projects (HERO 'project matches') with project number, trade/measure, customer, site address and current status. Use `search` to filter by customer name, city, status, etc.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Case-insensitive text filter applied to the results." },
        ...offsetProp,
        ...filtersProp,
      },
    },
    annotations: { title: "List projects", readOnlyHint: true, openWorldHint: true },
    handler: async (a) => {
      const args = { offset: a.offset ?? 0, ...(a.filters as object) };
      let rows = (await runRootField(client, schema, "query", "project_matches", args, PROJECT_SUMMARY_FIELDS)) as unknown[];
      if (typeof a.search === "string" && a.search.trim() && Array.isArray(rows)) {
        rows = rows.filter((r) => matches(r, a.search as string));
      }
      return text({ count: Array.isArray(rows) ? rows.length : undefined, offset: args.offset, results: rows });
    },
  });

  server.register({
    name: "hero_get_project",
    description:
      "Get full details for one or more projects by id: customer, contact person, site address, status, all documents (quotes, invoices, with PDF links) and the project logbook/history.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "integer" }, minItems: 1, description: "HERO project ids." },
      },
      required: ["ids"],
    },
    annotations: { title: "Get project details", readOnlyHint: true, openWorldHint: true },
    handler: async (a) => {
      const rows = await runRootField(client, schema, "query", "project_matches", { ids: a.ids }, PROJECT_DETAIL_FIELDS);
      return text(rows);
    },
  });

  server.register({
    name: "hero_list_documents",
    description:
      "List customer documents (quotes/Angebote, invoices/Rechnungen, order confirmations, ...) with number, type, net value, VAT, status and PDF link. Use `search` to filter, e.g. by document type name.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Case-insensitive text filter applied to the results." },
        ...offsetProp,
        ...filtersProp,
      },
    },
    annotations: { title: "List documents", readOnlyHint: true, openWorldHint: true },
    handler: async (a) => {
      const args = { offset: a.offset ?? 0, ...(a.filters as object) };
      let rows = (await runRootField(client, schema, "query", "customer_documents", args, DOCUMENT_FIELDS)) as unknown[];
      if (typeof a.search === "string" && a.search.trim() && Array.isArray(rows)) {
        rows = rows.filter((r) => matches(r, a.search as string));
      }
      return text({ count: Array.isArray(rows) ? rows.length : undefined, offset: args.offset, results: rows });
    },
  });

  server.register({
    name: "hero_list_appointments",
    description:
      "List calendar events/appointments (Termine) from HERO. Fields are selected automatically from the HERO schema. Pass date filters via `filters` (see hero_schema for calendar_events).",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Case-insensitive text filter applied to the results." },
        ...offsetProp,
        ...filtersProp,
      },
    },
    annotations: { title: "List appointments", readOnlyHint: true, openWorldHint: true },
    handler: async (a) => {
      const field = await schema.rootField("query", "calendar_events");
      const args: Record<string, unknown> = { ...(a.filters as object) };
      if (field.args.some((x) => x.name === "offset")) args.offset = a.offset ?? 0;
      let rows = (await runRootField(client, schema, "query", "calendar_events", args)) as unknown[];
      if (typeof a.search === "string" && a.search.trim() && Array.isArray(rows)) {
        rows = rows.filter((r) => matches(r, a.search as string));
      }
      return text({ count: Array.isArray(rows) ? rows.length : undefined, results: rows });
    },
  });

  server.register({
    name: "hero_list_products",
    description:
      "List products/articles from the HERO product catalogue (supply product versions), e.g. to look up prices or article numbers. Fields are selected automatically from the HERO schema.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Case-insensitive text filter applied to the results." },
        ...offsetProp,
        ...filtersProp,
      },
    },
    annotations: { title: "List products", readOnlyHint: true, openWorldHint: true },
    handler: async (a) => {
      const field = await schema.rootField("query", "supply_product_versions");
      const args: Record<string, unknown> = { ...(a.filters as object) };
      if (field.args.some((x) => x.name === "offset")) args.offset = a.offset ?? 0;
      let rows = (await runRootField(client, schema, "query", "supply_product_versions", args)) as unknown[];
      if (typeof a.search === "string" && a.search.trim() && Array.isArray(rows)) {
        rows = rows.filter((r) => matches(r, a.search as string));
      }
      return text({ count: Array.isArray(rows) ? rows.length : undefined, results: rows });
    },
  });

  server.register({
    name: "hero_schema",
    description:
      "Explore the HERO GraphQL schema. Without arguments: lists all available queries and mutations with their arguments. With `type`: lists the fields of that type (e.g. the return type of calendar_events). Use this before hero_graphql or when you need filter arguments.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "GraphQL type name to inspect, e.g. 'Contact' or an input type." },
      },
    },
    annotations: { title: "Explore HERO schema", readOnlyHint: true, openWorldHint: true },
    handler: async (a) => {
      const describe = (fields: Awaited<ReturnType<SchemaCache["fields"]>>) =>
        fields.map((f) => ({
          name: f.name,
          type: typeRefToString(f.type),
          ...(f.args.length ? { args: f.args.map((x) => `${x.name}: ${typeRefToString(x.type)}`) } : {}),
          ...(f.description ? { description: f.description } : {}),
        }));
      if (typeof a.type === "string" && a.type) {
        return text({ type: a.type, fields: describe(await schema.fields(a.type)) });
      }
      const roots = await schema.roots();
      const queries = describe(await schema.fields(roots.query));
      const mutations = roots.mutation ? describe(await schema.fields(roots.mutation)) : [];
      return text({
        queries,
        mutations,
        note: opts.allowWrites ? "Writes enabled." : "Writes disabled (HERO_ALLOW_WRITES is not true): mutations will be refused.",
      });
    },
  });

  server.register({
    name: "hero_graphql",
    description:
      "Run a custom GraphQL query against HERO for anything the other tools don't cover. Read-only unless the server was started with HERO_ALLOW_WRITES=true. Use hero_schema to discover fields first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "GraphQL document." },
        variables: { type: "object", additionalProperties: true },
      },
      required: ["query"],
    },
    annotations: { title: "Custom GraphQL", openWorldHint: true },
    handler: async (a) => {
      const doc = String(a.query);
      if (isMutation(doc)) writeGuard(opts);
      return text(await client.graphql(doc, (a.variables as Record<string, unknown>) ?? {}));
    },
  });

  // --------------------------------------------------------------- Write tools

  server.register({
    name: "hero_create_lead",
    description:
      "Create a new customer enquiry/project in HERO via the Lead API (e.g. from a phone call, email or website form). Requires customer email and ZIP code. HERO de-duplicates customers by email. Requires HERO_ALLOW_WRITES=true. Always confirm the details with the user before calling.",
    inputSchema: {
      type: "object",
      properties: {
        measure: { type: "string", description: "Trade/measure code, default 'PRJ'. Available codes depend on the HERO account." },
        customer: {
          type: "object",
          properties: {
            email: { type: "string" },
            first_name: { type: "string" },
            last_name: { type: "string" },
            title: { type: "string", enum: ["Herr", "Frau", "HerrFrau"] },
            company_name: { type: "string", description: "Setting this makes the customer a business customer." },
            phone_home: { type: "string" },
            phone_mobile: { type: "string" },
          },
          required: ["email"],
        },
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            zipcode: { type: "string" },
            city: { type: "string" },
            country_code: { type: "string", enum: ["DE", "AT", "CH"] },
          },
          required: ["zipcode"],
        },
        projectaddress: {
          type: "object",
          description: "Job site address if different from the customer address.",
          properties: {
            street: { type: "string" },
            zipcode: { type: "string" },
            city: { type: "string" },
            country_code: { type: "string", enum: ["DE", "AT", "CH"] },
          },
        },
        project: {
          type: "object",
          properties: {
            source: { type: "string", description: "Where the lead came from, e.g. 'Telefon' or 'example.de - Kontaktformular'." },
            source_medium: { type: "string" },
            lead_id: { type: "string", description: "External id in the form 'Source/UniqueId'." },
          },
        },
        comment: { type: "string", description: "Description of the request; added to the project logbook." },
        status_code: {
          type: "integer",
          enum: [201, 400, 601, 801, 1111],
          description: "Initial status: 201 first contact (default), 400 site visit, 601 quote, 801 order, 1111 in progress.",
        },
      },
      required: ["customer", "address"],
    },
    annotations: { title: "Create lead/project", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: async (a): Promise<ToolResult> => {
      writeGuard(opts);
      const payload: Record<string, unknown> = {
        ...(a.measure ? { measure: a.measure } : {}),
        customer: a.customer,
        address: a.address,
        ...(a.projectaddress ? { projectaddress: a.projectaddress } : {}),
        project: { source: "AI-Assistent (MCP)", ...((a.project as object) ?? {}) },
      };
      if (a.comment || a.status_code) {
        payload.project_match = {
          ...(a.status_code ? { status_code: a.status_code } : {}),
          ...(a.comment ? { comment: a.comment } : {}),
        };
      }
      const res = await client.createLead(payload);
      return text({ created: true, project_id: res.id, hero_response: res });
    },
  });

  server.register({
    name: "hero_add_logbook_entry",
    description:
      "Add an entry to a project's logbook in HERO (e.g. a call note or site-visit summary). The exact argument names come from the HERO schema: call hero_schema and look at the add_logbook_entry mutation first, then pass them in `arguments`. Requires HERO_ALLOW_WRITES=true.",
    inputSchema: {
      type: "object",
      properties: {
        arguments: { type: "object", additionalProperties: true, description: "Arguments for the add_logbook_entry mutation." },
        selection: { type: "string", description: "Optional fields to return, e.g. 'id'." },
      },
      required: ["arguments"],
    },
    annotations: { title: "Add logbook entry", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: async (a) => {
      writeGuard(opts);
      const field = await schema.rootField("mutation", "add_logbook_entry");
      const sel =
        (a.selection as string | undefined) ??
        (namedType(field.type).kind === "OBJECT" ? await schema.scalarSelection(namedType(field.type).name!) : undefined);
      return text(
        await runRootField(client, schema, "mutation", "add_logbook_entry", a.arguments as Record<string, unknown>, sel),
      );
    },
  });
}

export const __test = { isMutation };
