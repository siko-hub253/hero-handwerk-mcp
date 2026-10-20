/**
 * GraphQL introspection helpers.
 *
 * HERO only documents a handful of fields publicly; the full schema is
 * available through introspection. We use it to (a) declare variable types
 * correctly and (b) auto-select scalar fields for types whose shape is not
 * documented (e.g. calendar events, products).
 */

import type { HeroClient } from "./hero.js";

export interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}

export interface FieldInfo {
  name: string;
  description?: string | null;
  args: Array<{ name: string; description?: string | null; type: TypeRef }>;
  type: TypeRef;
}

const TYPE_REF = `
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
`;

export function typeRefToString(t: TypeRef): string {
  if (t.kind === "NON_NULL" && t.ofType) return `${typeRefToString(t.ofType)}!`;
  if (t.kind === "LIST" && t.ofType) return `[${typeRefToString(t.ofType)}]`;
  return t.name ?? "Unknown";
}

export function namedType(t: TypeRef): TypeRef {
  let cur = t;
  while ((cur.kind === "NON_NULL" || cur.kind === "LIST") && cur.ofType) cur = cur.ofType;
  return cur;
}

export class SchemaCache {
  private rootNames?: { query: string; mutation: string | null };
  private typeFields = new Map<string, FieldInfo[]>();

  constructor(private readonly client: HeroClient) {}

  async roots(): Promise<{ query: string; mutation: string | null }> {
    if (!this.rootNames) {
      const data = await this.client.graphql<{
        __schema: { queryType: { name: string }; mutationType: { name: string } | null };
      }>(`{ __schema { queryType { name } mutationType { name } } }`);
      this.rootNames = {
        query: data.__schema.queryType.name,
        mutation: data.__schema.mutationType?.name ?? null,
      };
    }
    return this.rootNames;
  }

  async fields(typeName: string): Promise<FieldInfo[]> {
    const cached = this.typeFields.get(typeName);
    if (cached) return cached;
    const data = await this.client.graphql<{ __type: { fields: FieldInfo[] | null; inputFields?: FieldInfo[] | null } | null }>(
      `query($name: String!) { __type(name: $name) {
         fields { name description args { name description type { ${TYPE_REF} } } type { ${TYPE_REF} } }
         inputFields { name description type { ${TYPE_REF} } }
       } }`,
      { name: typeName },
    );
    if (!data.__type) throw new Error(`Type "${typeName}" not found in HERO schema`);
    const fields = (data.__type.fields ?? data.__type.inputFields ?? []).map((f) => ({ ...f, args: f.args ?? [] }));
    this.typeFields.set(typeName, fields);
    return fields;
  }

  async rootField(op: "query" | "mutation", fieldName: string): Promise<FieldInfo> {
    const roots = await this.roots();
    const rootName = op === "query" ? roots.query : roots.mutation;
    if (!rootName) throw new Error("HERO schema has no mutation type");
    const field = (await this.fields(rootName)).find((f) => f.name === fieldName);
    if (!field) throw new Error(`HERO schema has no ${op} field "${fieldName}"`);
    return field;
  }

  /** Scalar/enum field names of an object type, for an automatic selection set. */
  async scalarSelection(typeName: string, max = 40): Promise<string> {
    const fields = await this.fields(typeName);
    const scalars = fields
      .filter((f) => f.args.every((a) => a.type.kind !== "NON_NULL")) // skip fields with required args
      .filter((f) => ["SCALAR", "ENUM"].includes(namedType(f.type).kind))
      .map((f) => f.name)
      .slice(0, max);
    return scalars.length ? scalars.join(" ") : "__typename";
  }
}

/**
 * Build and run `op { field(args) { selection } }` with properly typed variables.
 * Arguments are validated against the schema so the model gets a clear error
 * listing valid argument names instead of an opaque GraphQL failure.
 */
export async function runRootField(
  client: HeroClient,
  schema: SchemaCache,
  op: "query" | "mutation",
  fieldName: string,
  args: Record<string, unknown>,
  selection?: string,
): Promise<unknown> {
  const field = await schema.rootField(op, fieldName);
  const provided = Object.entries(args).filter(([, v]) => v !== undefined && v !== null);

  const decls: string[] = [];
  const callArgs: string[] = [];
  const variables: Record<string, unknown> = {};
  for (const [name, value] of provided) {
    const argDef = field.args.find((a) => a.name === name);
    if (!argDef) {
      const valid = field.args.map((a) => `${a.name}: ${typeRefToString(a.type)}`).join(", ") || "(none)";
      throw new Error(`"${fieldName}" has no argument "${name}". Valid arguments: ${valid}`);
    }
    decls.push(`$${name}: ${typeRefToString(argDef.type)}`);
    callArgs.push(`${name}: $${name}`);
    variables[name] = value;
  }

  let sel = selection;
  const ret = namedType(field.type);
  if (!sel && ret.kind === "OBJECT" && ret.name) sel = await schema.scalarSelection(ret.name);
  const selBlock = sel && ret.kind !== "SCALAR" && ret.kind !== "ENUM" ? ` { ${sel} }` : "";

  const doc = `${op}${decls.length ? `(${decls.join(", ")})` : ""} { ${fieldName}${
    callArgs.length ? `(${callArgs.join(", ")})` : ""
  }${selBlock} }`;
  const data = await client.graphql<Record<string, unknown>>(doc, variables);
  return data[fieldName] ?? data;
}
