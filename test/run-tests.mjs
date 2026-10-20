// End-to-end test: starts a mock HERO API, launches the MCP server over stdio,
// and drives it with JSON-RPC like a real MCP client (Claude Desktop etc.) would.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const KEY = "test-key";
const seen = [];

const T = (kind, name, ofType = null) => ({ kind, name, ofType });
const NN = (t) => T("NON_NULL", null, t);
const L = (t) => T("LIST", null, t);
const arg = (name, type) => ({ name, description: null, type });
const fld = (name, type, args = []) => ({ name, description: null, args, type });

const TYPES = {
  Query: [
    fld("contacts", L(T("OBJECT", "Contact")), [arg("category", T("ENUM", "ContactCategory")), arg("orderBy", T("SCALAR", "String")), arg("offset", T("SCALAR", "Int"))]),
    fld("project_matches", L(T("OBJECT", "ProjectMatch")), [arg("ids", L(T("SCALAR", "Int"))), arg("offset", T("SCALAR", "Int"))]),
    fld("customer_documents", L(T("OBJECT", "CustomerDocument")), [arg("offset", T("SCALAR", "Int"))]),
    fld("calendar_events", L(T("OBJECT", "CalendarEvent")), [arg("start", T("SCALAR", "DateTime")), arg("offset", T("SCALAR", "Int"))]),
    fld("supply_product_versions", L(T("OBJECT", "SupplyProductVersion")), [arg("offset", T("SCALAR", "Int"))]),
  ],
  Mutation: [
    fld("add_logbook_entry", T("OBJECT", "LogbookEntry"), [arg("project_match_id", NN(T("SCALAR", "Int"))), arg("text", NN(T("SCALAR", "String")))]),
  ],
  CalendarEvent: [fld("id", T("SCALAR", "Int")), fld("title", T("SCALAR", "String")), fld("start", T("SCALAR", "DateTime")), fld("project", T("OBJECT", "ProjectMatch"))],
  SupplyProductVersion: [fld("id", T("SCALAR", "Int")), fld("name", T("SCALAR", "String")), fld("net_price", T("SCALAR", "Float"))],
  LogbookEntry: [fld("id", T("SCALAR", "Int")), fld("text", T("SCALAR", "String"))],
};

function graphql(query, variables) {
  if (query.includes("__schema")) return { data: { __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" } } } };
  if (query.includes("__type")) {
    const f = TYPES[variables.name];
    return { data: { __type: f ? { fields: f, inputFields: null } : null } };
  }
  if (query.includes("add_logbook_entry")) return { data: { add_logbook_entry: { id: 9, text: variables.text } } };
  if (query.includes("contacts"))
    return { data: { contacts: [
      { id: 1, nr: "K-1001", first_name: "Anna", last_name: "Schmidt", company_name: null, email: "anna@example.de", phone_home: "+4930123", address: { street: "Hauptstr. 1", city: "Berlin", zipcode: "10117" } },
      { id: 2, nr: "K-1002", first_name: "Jonas", last_name: "Weber", company_name: "Weber GmbH", email: "jw@weber.de", phone_home: null, address: { street: "Ring 5", city: "Hamburg", zipcode: "20095" } },
    ] } };
  if (query.includes("project_matches"))
    return { data: { project_matches: [{ id: 150798, project_nr: "P-2026-001", measure: { short: "PVS", name: "Photovoltaik" }, customer: { id: 1, first_name: "Anna", last_name: "Schmidt", email: "anna@example.de" }, address: { street: "Hauptstr. 1", city: "Berlin", zipcode: "10117" }, current_project_match_status: { status_code: 601, name: "Angebot" } }] } };
  if (query.includes("calendar_events")) return { data: { calendar_events: [{ id: 5, title: "Aufmaß Schmidt", start: "2026-10-21T09:00:00" }] } };
  if (query.includes("supply_product_versions")) return { data: { supply_product_versions: [{ id: 3, name: "Kupferrohr 15mm", net_price: 7.9 }] } };
  return { errors: [{ message: "unknown query" }] };
}

const api = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(403, { message: "forbidden" });
    const json = JSON.parse(body || "{}");
    seen.push({ url: req.url, json });
    if (req.url === "/api/external/v7/graphql") return send(200, graphql(json.query, json.variables ?? {}));
    if (req.url === "/api/v1/Projects/create") {
      if (!json.address?.zipcode) return send(422, { status: "error", message: "Fehlende Postleitzahl", validationErrors: {} });
      return send(200, { status: "success", id: 12345 });
    }
    send(404, {});
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${api.address().port}`;

function startMcp(env) {
  const proc = spawn(process.execPath, ["dist/index.js"], { env: { ...process.env, HERO_BASE_URL: base, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pending = new Map();
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg); pending.delete(msg.id);
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => { const myId = ++id; pending.set(myId, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n"); });
  const tool = async (name, args) => { const r = await call("tools/call", { name, arguments: args }); return { ...r.result, data: r.result?.isError ? null : JSON.parse(r.result.content[0].text) }; };
  return { proc, call, tool, notify: (method) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n") };
}

let passed = 0;
const ok = (name) => { passed++; console.log("  ✓", name); };

// ---------- read-only server
const ro = startMcp({ HERO_API_KEY: KEY });
const init = await ro.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
assert.equal(init.result.serverInfo.name, "hero-handwerk-mcp");
assert.equal(init.result.protocolVersion, "2025-06-18");
ro.notify("notifications/initialized");
ok("initialize handshake");

const list = await ro.call("tools/list", {});
const names = list.result.tools.map((t) => t.name);
for (const n of ["hero_list_customers", "hero_list_projects", "hero_get_project", "hero_list_documents", "hero_list_appointments", "hero_list_products", "hero_schema", "hero_graphql", "hero_create_lead", "hero_add_logbook_entry"]) assert.ok(names.includes(n), n);
ok(`tools/list returns ${names.length} tools`);

let r = await ro.tool("hero_list_customers", { search: "weber" });
assert.equal(r.data.count, 1); assert.equal(r.data.results[0].company_name, "Weber GmbH");
const contactsCall = seen.findLast((s) => s.json.query?.includes("contacts"));
assert.match(contactsCall.json.query, /\$category: ContactCategory/, "enum type declared from schema");
assert.equal(contactsCall.json.variables.category, "customer");
ok("hero_list_customers: search filter + schema-typed variables");

r = await ro.tool("hero_get_project", { ids: [150798] });
assert.equal(r.data[0].current_project_match_status.name, "Angebot");
assert.match(seen.findLast((s) => s.json.query?.includes("project_matches")).json.query, /\$ids: \[Int\]/);
ok("hero_get_project");

r = await ro.tool("hero_list_appointments", { filters: { start: "2026-10-21" } });
assert.equal(r.data.results[0].title, "Aufmaß Schmidt");
const calQ = seen.findLast((s) => s.json.query?.includes("calendar_events")).json.query;
assert.match(calQ, /id title start/); assert.doesNotMatch(calQ, /project/, "objects not auto-selected");
ok("hero_list_appointments: auto-selected scalar fields + filters");

r = await ro.tool("hero_list_products", { search: "kupfer" });
assert.equal(r.data.count, 1);
ok("hero_list_products");

r = await ro.tool("hero_list_customers", { filters: { nonsense: 1 } });
assert.equal(r.isError, true); assert.match(r.content[0].text, /Valid arguments: category/);
ok("unknown filter gives helpful error");

r = await ro.tool("hero_schema", {});
assert.ok(r.data.mutations.some((m) => m.name === "add_logbook_entry"));
ok("hero_schema");

r = await ro.tool("hero_create_lead", { customer: { email: "a@b.de" }, address: { zipcode: "10117" } });
assert.equal(r.isError, true); assert.match(r.content[0].text, /Write access is disabled/);
r = await ro.tool("hero_graphql", { query: "mutation { add_logbook_entry(project_match_id: 1, text: \"x\") { id } }" });
assert.equal(r.isError, true);
r = await ro.tool("hero_graphql", { query: "# a mutation comment\n{ contacts { id } }" });
assert.ok(!r.isError, "comment mentioning mutation is not a write");
ok("read-only mode blocks writes (incl. raw GraphQL mutations)");
ro.proc.kill();

// ---------- read/write server
const rw = startMcp({ HERO_API_KEY: KEY, HERO_ALLOW_WRITES: "true" });
await rw.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
r = await rw.tool("hero_create_lead", { customer: { email: "neu@kunde.de", last_name: "Neu" }, address: { zipcode: "80331", city: "München" }, comment: "Bad sanieren", status_code: 201 });
assert.equal(r.data.project_id, 12345);
const lead = seen.findLast((s) => s.url === "/api/v1/Projects/create").json;
assert.equal(lead.project_match.comment, "Bad sanieren"); assert.equal(lead.project.source, "AI-Assistent (MCP)");
ok("hero_create_lead");

r = await rw.tool("hero_create_lead", { customer: { email: "x@y.de" }, address: {} });
assert.equal(r.isError, true); assert.match(r.content[0].text, /Fehlende Postleitzahl/);
ok("lead validation error surfaced");

r = await rw.tool("hero_add_logbook_entry", { arguments: { project_match_id: 150798, text: "Kunde angerufen" } });
assert.equal(r.data.text, "Kunde angerufen");
assert.match(seen.findLast((s) => s.json.query?.includes("add_logbook_entry")).json.query, /\$project_match_id: Int!/);
ok("hero_add_logbook_entry");
rw.proc.kill();

// ---------- bad key
const bad = startMcp({ HERO_API_KEY: "wrong" });
await bad.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
r = await bad.tool("hero_list_projects", {});
assert.equal(r.isError, true); assert.match(r.content[0].text, /rejected the API key/);
ok("invalid API key gives clear error");
bad.proc.kill();

// ---------- missing key
const missing = spawn(process.execPath, ["dist/index.js"], { env: { ...process.env, HERO_API_KEY: "" } });
const code = await new Promise((r) => missing.on("exit", r));
assert.equal(code, 1);
ok("exits with message when HERO_API_KEY missing");

api.close();
console.log(`\n${passed} tests passed`);
