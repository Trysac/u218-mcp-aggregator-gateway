import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export type { Tool };

/**
 * Minimal subset of the MCP SDK Client interface that the gateway needs.
 * An SDK Client satisfies this structurally.
 */
export interface Upstream {
  listTools(): Promise<{ tools: Tool[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

/** Per-client access policy using anchored, case-sensitive globs with `*` as the only wildcard. */
export interface AccessPolicy {
  clients: Record<string, { allow: string[]; deny?: string[] }>;
}

/** Injectable timer functions so tests can control time deterministically. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Event payload emitted via the optional `onEvent` callback. */
export type GatewayEvent =
  | {
      event: "call";
      client: string;
      tool: string;
      outcome: "ok" | "denied" | "error" | "timeout" | "too_large";
    }
  | { event: "skipped_tool"; server: string }
  | { event: "upstream_unavailable"; server: string };

/** Stable error codes for gateway-specific failures. */
export class GatewayError extends Error {
  readonly code: "invalid_config" | "unknown_tool";

  constructor(code: "invalid_config" | "unknown_tool", message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}

const VALID_SERVER_NAME = /^[a-z0-9-]{1,32}$/;
const VALID_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

function isValidToolName(name: string): boolean {
  return VALID_TOOL_NAME.test(name);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesGlob(name: string, glob: string): boolean {
  const pattern = glob.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${pattern}$`).test(name);
}

/**
 * Aggregates tools from multiple MCP upstream servers, exposing them under
 * `<server>__<tool>` names and enforcing a fail-closed per-client access policy.
 */
export class Gateway {
  private readonly upstreams: Record<string, Upstream>;
  private readonly policy: AccessPolicy;
  private readonly timeoutMs: number;
  private readonly maxResultBytes: number;
  private readonly timers: Timers;
  private readonly onEvent: ((event: GatewayEvent) => void) | undefined;

  private toolLists: Map<string, Tool[]> = new Map();
  private initialized = false;
  private refreshPromise: Promise<void> | null = null;

  constructor(opts: {
    upstreams: Record<string, Upstream>;
    policy: AccessPolicy;
    timeoutMs?: number;
    maxResultBytes?: number;
    timers?: Timers;
    onEvent?: (event: GatewayEvent) => void;
  }) {
    this.upstreams = opts.upstreams;
    this.policy = opts.policy;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxResultBytes = opts.maxResultBytes ?? 1_048_576;
    this.timers = opts.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.onEvent = opts.onEvent;

    this.validateConfig();
  }

  private validateConfig(): void {
    for (const name of Object.keys(this.upstreams)) {
      if (!VALID_SERVER_NAME.test(name)) {
        throw new GatewayError("invalid_config", `Invalid server name: ${name}`);
      }
    }

    for (const [client, clientPolicy] of Object.entries(this.policy.clients)) {
      if (!Array.isArray(clientPolicy.allow)) {
        throw new GatewayError("invalid_config", `Client "${client}" must have an allow list`);
      }
      if (clientPolicy.deny !== undefined && !Array.isArray(clientPolicy.deny)) {
        throw new GatewayError("invalid_config", `Client "${client}" must have a deny list`);
      }
      const deny = clientPolicy.deny ?? [];
      const totalGlobs = clientPolicy.allow.length + deny.length;
      if (totalGlobs > 100) {
        throw new GatewayError("invalid_config", `Client "${client}" has more than 100 globs`);
      }
      for (const glob of [...clientPolicy.allow, ...deny]) {
        if (typeof glob !== "string" || glob.length > 200) {
          throw new GatewayError(
            "invalid_config",
            `Client "${client}" has a glob that is not a string or exceeds 200 characters`,
          );
        }
      }
    }

    if (this.timeoutMs <= 0) {
      throw new GatewayError("invalid_config", "timeoutMs must be positive");
    }
    if (this.maxResultBytes <= 0) {
      throw new GatewayError("invalid_config", "maxResultBytes must be positive");
    }
  }

  private emit(event: GatewayEvent): void {
    this.onEvent?.(event);
  }

  private isToolVisible(clientId: string, namespacedName: string): boolean {
    const clientPolicy = Object.hasOwn(this.policy.clients, clientId)
      ? this.policy.clients[clientId]
      : undefined;
    if (!clientPolicy || !Array.isArray(clientPolicy.allow)) {
      return false;
    }
    const allowMatch = clientPolicy.allow.some((glob) => matchesGlob(namespacedName, glob));
    if (!allowMatch) {
      return false;
    }
    const denyMatch = clientPolicy.deny?.some((glob) => matchesGlob(namespacedName, glob)) ?? false;
    return !denyMatch;
  }

  private async performRefresh(): Promise<void> {
    const entries = Object.entries(this.upstreams);
    const results = await Promise.allSettled(
      entries.map(async ([, upstream]) => {
        let handle: unknown;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          handle = this.timers.setTimeout(() => {
            reject(new Error("upstream listTools timed out"));
          }, this.timeoutMs);
        });
        try {
          return await Promise.race([upstream.listTools(), timeoutPromise]);
        } finally {
          this.timers.clearTimeout(handle);
        }
      }),
    );

    const newToolLists = new Map<string, Tool[]>();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) {
        continue;
      }
      const [server] = entry;
      const result = results[i];

      if (result?.status !== "fulfilled") {
        this.emit({ event: "upstream_unavailable", server });
        continue;
      }

      const payload: unknown = result.value;
      const tools: unknown = (payload as { tools?: unknown } | null)?.tools;
      if (!payload || !Array.isArray(tools)) {
        this.emit({ event: "upstream_unavailable", server });
        continue;
      }

      const validTools: Tool[] = [];
      for (const candidate of tools as unknown[]) {
        try {
          if (
            !candidate ||
            typeof candidate !== "object" ||
            typeof (candidate as { name?: unknown }).name !== "string"
          ) {
            this.emit({ event: "skipped_tool", server });
            continue;
          }
          const tool = candidate as Tool;
          const namespacedName = `${server}__${tool.name}`;
          if (isValidToolName(namespacedName)) {
            validTools.push(tool);
          } else {
            this.emit({ event: "skipped_tool", server });
          }
        } catch {
          this.emit({ event: "skipped_tool", server });
        }
      }
      newToolLists.set(server, validTools);
    }

    this.toolLists = newToolLists;
    this.initialized = true;
  }

  private loadTools(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  /**
   * Re-fetches tool lists from all upstreams, even if they were previously fetched.
   * Failed upstreams are skipped and reported via `onEvent` until they recover.
   */
  async refresh(): Promise<void> {
    await this.loadTools();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.loadTools();
    }
  }

  /**
   * Returns the tools visible to `clientId` under their namespaced names, sorted ascending.
   */
  async listTools(clientId: string): Promise<Tool[]> {
    await this.ensureInitialized();
    const visible: Tool[] = [];
    for (const [server, tools] of this.toolLists) {
      for (const tool of tools) {
        const namespacedName = `${server}__${tool.name}`;
        if (this.isToolVisible(clientId, namespacedName)) {
          visible.push({ ...tool, name: namespacedName });
        }
      }
    }
    visible.sort((a, b) => {
      if (a.name < b.name) {
        return -1;
      }
      if (a.name > b.name) {
        return 1;
      }
      return 0;
    });
    return visible;
  }

  /**
   * Calls a tool on behalf of a client. Hidden and unknown tools are indistinguishable
   * and throw `GatewayError` with code `unknown_tool`.
   */
  async callTool(
    clientId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    await this.ensureInitialized();

    if (!this.isToolVisible(clientId, name)) {
      this.emit({
        event: "call",
        client: clientId,
        tool: truncate(name, 128),
        outcome: "denied",
      });
      throw new GatewayError("unknown_tool", `Unknown tool: ${truncate(name, 128)}`);
    }

    const separatorIndex = name.indexOf("__");
    if (separatorIndex <= 0) {
      throw new GatewayError("unknown_tool", `Unknown tool: ${truncate(name, 128)}`);
    }
    const server = name.slice(0, separatorIndex);
    const originalTool = name.slice(separatorIndex + 2);
    const upstream = this.upstreams[server];
    const cachedTools = this.toolLists.get(server);
    if (!upstream || !cachedTools?.some((tool) => tool.name === originalTool)) {
      this.emit({
        event: "call",
        client: clientId,
        tool: truncate(name, 128),
        outcome: "denied",
      });
      throw new GatewayError("unknown_tool", `Unknown tool: ${truncate(name, 128)}`);
    }

    const controller = new AbortController();
    let timedOut = false;
    let timeoutResolve!: () => void;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutResolve = resolve;
    });
    const timerHandle = this.timers.setTimeout(() => {
      timedOut = true;
      controller.abort();
      timeoutResolve();
    }, this.timeoutMs);

    const upstreamCall = Promise.resolve().then(() =>
      upstream.callTool({ name: originalTool, arguments: args }, undefined, {
        signal: controller.signal,
      }),
    );

    const guardedUpstream = upstreamCall.then(
      (result) => ({ status: "ok" as const, result }),
      () => ({ status: timedOut ? ("timeout" as const) : ("error" as const) }),
    );

    const outcome = await Promise.race([
      guardedUpstream,
      timeoutPromise.then(() => ({ status: "timeout" as const })),
    ]);

    this.timers.clearTimeout(timerHandle);

    if (outcome.status === "ok") {
      let json: string | undefined;
      try {
        json = JSON.stringify(outcome.result);
      } catch {
        json = undefined;
      }
      if (typeof json !== "string") {
        this.emit({ event: "call", client: clientId, tool: name, outcome: "error" });
        return { isError: true, content: [{ type: "text", text: "Tool call failed" }] };
      }
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes > this.maxResultBytes) {
        this.emit({ event: "call", client: clientId, tool: name, outcome: "too_large" });
        return { isError: true, content: [{ type: "text", text: "Tool result too large" }] };
      }
      this.emit({ event: "call", client: clientId, tool: name, outcome: "ok" });
      return outcome.result as CallToolResult;
    }

    if (outcome.status === "timeout") {
      this.emit({ event: "call", client: clientId, tool: name, outcome: "timeout" });
      return { isError: true, content: [{ type: "text", text: "Tool call timed out" }] };
    }

    this.emit({ event: "call", client: clientId, tool: name, outcome: "error" });
    return { isError: true, content: [{ type: "text", text: "Tool call failed" }] };
  }

  /**
   * Creates an MCP Server bound to a single client identity. The server exposes
   * `tools/list` and `tools/call` and maps unknown tools to JSON-RPC -32602.
   */
  connect(clientId: string): Server {
    const server = new Server(
      { name: "mcp-aggregator-gateway", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: await this.listTools(clientId) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        return await this.callTool(clientId, name, args ?? {});
      } catch (error) {
        if (error instanceof GatewayError && error.code === "unknown_tool") {
          throw new McpError(ErrorCode.InvalidParams, error.message);
        }
        throw error;
      }
    });

    return server;
  }
}
