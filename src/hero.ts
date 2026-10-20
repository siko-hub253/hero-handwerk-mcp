/**
 * Thin client for the HERO Handwerkersoftware APIs.
 *
 * - GraphQL API:  POST {base}/api/external/v7/graphql
 * - Lead API:     POST {base}/api/v1/Projects/create
 *
 * Docs: https://hero-software.de/api-doku/graphql-guide
 *       https://hero-software.de/api-doku/lead-api
 */

export interface HeroConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

export class HeroApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HeroApiError";
  }
}

export class HeroClient {
  constructor(private readonly config: HeroConfig) {}

  get graphqlUrl(): string {
    return `${this.config.baseUrl}/api/external/v7/graphql`;
  }

  get leadUrl(): string {
    return `${this.config.baseUrl}/api/v1/Projects/create`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "hero-handwerk-mcp/0.1.0",
    };
  }

  private async post(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new HeroApiError(`HERO API timed out after ${this.config.timeoutMs} ms`);
      }
      throw new HeroApiError(`Could not reach HERO API: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    const raw = await res.text();
    let json: unknown = raw;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      /* keep raw text */
    }

    if (res.status === 401 || res.status === 403) {
      throw new HeroApiError(
        "HERO rejected the API key (HTTP " + res.status + "). Check HERO_API_KEY — keys are issued by HERO support.",
        res.status,
      );
    }
    if (!res.ok && res.status !== 422) {
      throw new HeroApiError(`HERO API returned HTTP ${res.status}`, res.status, json);
    }
    return { status: res.status, json };
  }

  /** Run a GraphQL operation. Throws if HERO returns GraphQL errors and no data. */
  async graphql<T = Record<string, unknown>>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const { json } = await this.post(this.graphqlUrl, { query, variables });
    const body = json as { data?: T; errors?: Array<{ message: string }> };
    if (body?.errors?.length && !body.data) {
      throw new HeroApiError(
        "GraphQL error: " + body.errors.map((e) => e.message).join("; "),
        undefined,
        body.errors,
      );
    }
    if (body?.errors?.length) {
      // Partial data: surface errors alongside the data.
      return { ...(body.data as object), _errors: body.errors } as T;
    }
    return (body?.data ?? {}) as T;
  }

  /** Create a project/lead through the HERO Lead API. */
  async createLead(payload: Record<string, unknown>): Promise<{ status: string; id?: number; message?: string; validationErrors?: unknown }> {
    const { status, json } = await this.post(this.leadUrl, payload);
    const body = (json ?? {}) as { status?: string; id?: number; message?: string; validationErrors?: unknown };
    if (status === 422 || body.status === "error") {
      throw new HeroApiError(
        `HERO refused the lead: ${body.message ?? "validation error"}`,
        status,
        body.validationErrors,
      );
    }
    return body as { status: string; id?: number };
  }
}
