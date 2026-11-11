import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type AccessPolicy,
  Gateway,
  GatewayError,
  type Timers,
  type Tool,
  type Upstream,
} from "../src/index.js";

type CallToolImpl = (params: {
  name: string;
  arguments?: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<unknown>;

const createMockUpstream = (tools: Tool[], callToolImpl?: CallToolImpl): Upstream => ({
  listTools: vi.fn(async () => ({ tools })),
  callTool: callToolImpl
    ? vi.fn(
        async (
          params: { name: string; arguments?: Record<string, unknown> },
          _resultSchema?: undefined,
          options?: { signal?: AbortSignal },
        ) => {
          const merged: {
            name: string;
            arguments?: Record<string, unknown>;
            signal?: AbortSignal;
          } = { name: params.name };
          if (params.arguments !== undefined) {
            merged.arguments = params.arguments;
          }
          if (options?.signal !== undefined) {
            merged.signal = options.signal;
          }
          return callToolImpl(merged);
        },
      )
    : vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
});

class ManualTimers implements Timers {
  private nextId = 1;
  private timers = new Map<unknown, { fn: () => void; due: number }>();
  private now = 0;

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = this.nextId++;
    this.timers.set(handle, { fn, due: this.now + ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle);
  }

  advance(ms: number): void {
    this.now += ms;
    const due = [...this.timers.entries()].filter(([, t]) => t.due <= this.now);
    for (const [handle, t] of due) {
      this.timers.delete(handle);
      t.fn();
    }
  }
}

describe("Gateway", () => {
  let githubTools: Tool[];
  let fsTools: Tool[];
  let githubUpstream: Upstream;
  let fsUpstream: Upstream;
  let policy: AccessPolicy;
  let events: unknown[];

  beforeEach(() => {
    githubTools = [
      {
        name: "search",
        description: "Search issues",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "create_issue",
        description: "Create issue",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    fsTools = [
      { name: "read", description: "Read file", inputSchema: { type: "object", properties: {} } },
    ];
    githubUpstream = createMockUpstream(githubTools);
    fsUpstream = createMockUpstream(fsTools);
    events = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeGateway(overrides: Partial<ConstructorParameters<typeof Gateway>[0]> = {}): Gateway {
    return new Gateway({
      upstreams: { github: githubUpstream, fs: fsUpstream },
      policy,
      onEvent: (e) => events.push(e),
      ...overrides,
    });
  }

  it("lists visible tools for client with allow glob, sorted ascending", async () => {
    policy = { clients: { alice: { allow: ["github__*"] } } };
    const gateway = makeGateway();
    const tools = await gateway.listTools("alice");
    expect(tools.map((t) => t.name)).toEqual(["github__create_issue", "github__search"]);
  });

  it("applies deny glob and returns empty for unknown client", async () => {
    policy = { clients: { alice: { allow: ["*"], deny: ["github__create_*"] } } };
    const gateway = makeGateway();
    const aliceTools = await gateway.listTools("alice");
    expect(aliceTools.map((t) => t.name)).toEqual(["fs__read", "github__search"]);
    const malloryTools = await gateway.listTools("mallory");
    expect(malloryTools).toEqual([]);
  });

  it("callTool forwards original tool name and arguments and returns result unchanged", async () => {
    policy = { clients: { alice: { allow: ["github__*"] } } };
    const callResult = { content: [{ type: "text", text: "42" }] };
    const callImpl = vi.fn(async () => callResult);
    const gh = createMockUpstream(githubTools, callImpl);
    const gateway = new Gateway({
      upstreams: { github: gh, fs: fsUpstream },
      policy,
      onEvent: (e) => events.push(e),
    });
    const result = await gateway.callTool("alice", "github__search", { q: "x" });
    expect(result).toEqual(callResult);
    expect(callImpl).toHaveBeenCalledWith({
      name: "search",
      arguments: { q: "x" },
      signal: expect.any(AbortSignal),
    });
  });

  it("throws GatewayError for denied or nonexistent tool and maps to -32602 via SDK client", async () => {
    policy = { clients: { alice: { allow: ["github__search"] } } };
    const gateway = makeGateway();
    await expect(gateway.callTool("alice", "github__create_issue", {})).rejects.toThrow(
      new GatewayError("unknown_tool", "Unknown tool: github__create_issue"),
    );
    expect(events).toContainEqual({
      event: "call",
      client: "alice",
      tool: "github__create_issue",
      outcome: "denied",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = gateway.connect("alice");
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    await expect(
      client.callTool({ name: "github__create_issue", arguments: {} }),
    ).rejects.toMatchObject({
      code: -32602,
    });
    await client.close();
    await server.close();
  });

  it("sanitizes upstream errors and does not leak details in events", async () => {
    policy = { clients: { alice: { allow: ["github__*"] } } };
    const gh = createMockUpstream(githubTools, async () => {
      throw new Error("secret path /srv/x");
    });
    const gateway = new Gateway({
      upstreams: { github: gh, fs: fsUpstream },
      policy,
      onEvent: (e) => events.push(e),
    });
    const result = await gateway.callTool("alice", "github__search", {});
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Tool call failed" }],
    });
    const eventStrings = events.map((e) => JSON.stringify(e));
    expect(eventStrings.join(" ")).not.toContain("secret path");
    expect(events).toContainEqual({
      event: "call",
      client: "alice",
      tool: "github__search",
      outcome: "error",
    });
  });

  it("rejects a non-existent tool matching an allow glob without calling the upstream", async () => {
    policy = { clients: { alice: { allow: ["github__*"] } } };
    const callImpl = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const gh = createMockUpstream(githubTools, callImpl);
    const gateway = new Gateway({
      upstreams: { github: gh, fs: fsUpstream },
      policy,
      onEvent: (e) => events.push(e),
    });
    await expect(gateway.callTool("alice", "github__nope", {})).rejects.toThrow(
      new GatewayError("unknown_tool", "Unknown tool: github__nope"),
    );
    expect(callImpl).not.toHaveBeenCalled();
  });

  it("times out and aborts signal using manual timers", async () => {
    policy = { clients: { alice: { allow: ["github__*"] } } };
    const timers = new ManualTimers();
    let capturedSignal: AbortSignal | undefined;
    const gh = createMockUpstream(githubTools, async ({ signal }) => {
      capturedSignal = signal;
      return new Promise(() => {}); // never settles
    });
    const gateway = new Gateway({
      upstreams: { github: gh, fs: fsUpstream },
      policy,
      timeoutMs: 100,
      timers,
      onEvent: (e) => events.push(e),
    });
    const resultPromise = gateway.callTool("alice", "github__search", {});
    // Let initialization finish and the timeout timer be registered.
    await new Promise((r) => setTimeout(r, 0));
    timers.advance(100);
    const result = await resultPromise;
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Tool call timed out" }],
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(events).toContainEqual({
      event: "call",
      client: "alice",
      tool: "github__search",
      outcome: "timeout",
    });
  });

  it("enforces maxResultBytes and validates server names in constructor", async () => {
    policy = { clients: { alice: { allow: ["github__*"] } } };
    const hugeResult = { content: [{ type: "text", text: "x".repeat(2_000_000) }] };
    const gh = createMockUpstream(githubTools, async () => hugeResult);
    const gateway = new Gateway({
      upstreams: { github: gh, fs: fsUpstream },
      policy,
      maxResultBytes: 1000,
      onEvent: (e) => events.push(e),
    });
    const result = await gateway.callTool("alice", "github__search", {});
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Tool result too large" }],
    });
    expect(events).toContainEqual({
      event: "call",
      client: "alice",
      tool: "github__search",
      outcome: "too_large",
    });

    expect(
      () =>
        new Gateway({
          upstreams: { Bad_Server: createMockUpstream([]) },
          policy,
        }),
    ).toThrow(new GatewayError("invalid_config", "Invalid server name: Bad_Server"));
  });

  it("emits call events with correct shape and no arguments or results", async () => {
    policy = { clients: { alice: { allow: ["github__*"] } } };
    const gh = createMockUpstream(githubTools, async () => ({ secret: "data" }));
    const gateway = new Gateway({
      upstreams: { github: gh, fs: fsUpstream },
      policy,
      onEvent: (e) => events.push(e),
    });
    await gateway.callTool("alice", "github__search", { hidden: true });
    expect(events).toContainEqual({
      event: "call",
      client: "alice",
      tool: "github__search",
      outcome: "ok",
    });
    const callEvents = events.filter((e) => (e as { event?: string }).event === "call");
    for (const event of callEvents) {
      expect(event).not.toHaveProperty("arguments");
      expect(event).not.toHaveProperty("result");
    }
  });

  it("handles name collisions between servers by namespacing", async () => {
    const collisionTools: Tool[] = [
      { name: "read", description: "Read", inputSchema: { type: "object" } },
    ];
    const fs2 = createMockUpstream(collisionTools);
    policy = { clients: { alice: { allow: ["*"] } } };
    const gateway = new Gateway({
      upstreams: { github: githubUpstream, fs: fsUpstream, fs2 },
      policy,
      onEvent: (e) => events.push(e),
    });
    const tools = await gateway.listTools("alice");
    const names = tools.map((t) => t.name);
    expect(names).toContain("fs__read");
    expect(names).toContain("fs2__read");
    expect(new Set(names).size).toBe(names.length);
  });

  it("refresh recovers after upstream failure", async () => {
    const failingUpstream = createMockUpstream([], async () => ({}));
    vi.mocked(failingUpstream.listTools).mockRejectedValueOnce(new Error("temporary failure"));
    const goodUpstream = createMockUpstream([
      { name: "ok", description: "", inputSchema: { type: "object" } },
    ]);
    policy = { clients: { alice: { allow: ["*"] } } };
    const gateway = new Gateway({
      upstreams: { bad: failingUpstream, good: goodUpstream },
      policy,
      onEvent: (e) => events.push(e),
    });
    let tools = await gateway.listTools("alice");
    expect(tools.map((t) => t.name)).toEqual(["good__ok"]);
    expect(events).toContainEqual({ event: "upstream_unavailable", server: "bad" });

    // Recover
    vi.mocked(failingUpstream.listTools).mockResolvedValueOnce({
      tools: [{ name: "recovered", description: "", inputSchema: { type: "object" } }],
    });
    await gateway.refresh();
    tools = await gateway.listTools("alice");
    expect(tools.map((t) => t.name)).toEqual(["bad__recovered", "good__ok"]);
  });

  it("survives malformed upstream listTools payloads", async () => {
    policy = { clients: { alice: { allow: ["*"] } } };
    const emptyPayload: Upstream = {
      listTools: vi.fn(async () => ({}) as unknown as { tools: Tool[] }),
      callTool: vi.fn(async () => ({ content: [] })),
    };
    const nullTools: Upstream = {
      listTools: vi.fn(async () => ({ tools: null }) as unknown as { tools: Tool[] }),
      callTool: vi.fn(async () => ({ content: [] })),
    };
    const badEntries: Upstream = {
      listTools: vi.fn(
        async () =>
          ({
            tools: [
              null,
              { description: "no name", inputSchema: { type: "object" } },
              { name: 42, inputSchema: { type: "object" } },
              { name: "good", description: "", inputSchema: { type: "object" } },
            ],
          }) as unknown as { tools: Tool[] },
      ),
      callTool: vi.fn(async () => ({ content: [] })),
    };
    const gateway = new Gateway({
      upstreams: { empty: emptyPayload, nulled: nullTools, bad: badEntries },
      policy,
      onEvent: (e) => events.push(e),
    });
    const tools = await gateway.listTools("alice");
    expect(tools.map((t) => t.name)).toEqual(["bad__good"]);
    expect(events).toContainEqual({ event: "upstream_unavailable", server: "empty" });
    expect(events).toContainEqual({ event: "upstream_unavailable", server: "nulled" });
    expect(events).toContainEqual({ event: "skipped_tool", server: "bad" });
    // A later call must not re-enter a permanently rejected initialisation.
    await expect(gateway.listTools("alice")).resolves.toHaveLength(1);
  });

  it("times out a hung upstream during tool discovery", async () => {
    policy = { clients: { alice: { allow: ["*"] } } };
    const timers = new ManualTimers();
    const hung: Upstream = {
      listTools: vi.fn(() => new Promise<{ tools: Tool[] }>(() => {})),
      callTool: vi.fn(async () => ({ content: [] })),
    };
    const good = createMockUpstream([
      { name: "ok", description: "", inputSchema: { type: "object" } },
    ]);
    const gateway = new Gateway({
      upstreams: { hung, good },
      policy,
      timeoutMs: 100,
      timers,
      onEvent: (e) => events.push(e),
    });
    const toolsPromise = gateway.listTools("alice");
    await new Promise((r) => setTimeout(r, 0));
    timers.advance(100);
    const tools = await toolsPromise;
    expect(tools.map((t) => t.name)).toEqual(["good__ok"]);
    expect(events).toContainEqual({ event: "upstream_unavailable", server: "hung" });

    const refreshPromise = gateway.refresh();
    await new Promise((r) => setTimeout(r, 0));
    timers.advance(100);
    await expect(refreshPromise).resolves.toBeUndefined();
  });

  it("sanitises upstream results that cannot be serialised", async () => {
    policy = { clients: { alice: { allow: ["*"] } } };
    const undefinedUpstream = createMockUpstream(githubTools, async () => undefined);
    const gateway = new Gateway({
      upstreams: { undef: undefinedUpstream },
      policy,
      onEvent: (e) => events.push(e),
    });
    await expect(gateway.callTool("alice", "undef__search", {})).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "Tool call failed" }],
    });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const circularUpstream = createMockUpstream(githubTools, async () => circular);
    const gateway2 = new Gateway({
      upstreams: { circ: circularUpstream },
      policy,
      onEvent: (e) => events.push(e),
    });
    await expect(gateway2.callTool("alice", "circ__search", {})).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "Tool call failed" }],
    });
    expect(events).toContainEqual({
      event: "call",
      client: "alice",
      tool: "circ__search",
      outcome: "error",
    });
  });

  it("late result after timeout is ignored without unhandled rejection", async () => {
    policy = { clients: { alice: { allow: ["github__*"] } } };
    const timers = new ManualTimers();
    let resolveLate!: (value: unknown) => void;
    const latePromise = new Promise((resolve) => {
      resolveLate = resolve;
    });
    const gh = createMockUpstream(githubTools, async () => latePromise);
    const gateway = new Gateway({
      upstreams: { github: gh, fs: fsUpstream },
      policy,
      timeoutMs: 50,
      timers,
      onEvent: (e) => events.push(e),
    });
    const resultPromise = gateway.callTool("alice", "github__search", {});
    // Let initialization finish and the timeout timer be registered.
    await new Promise((r) => setTimeout(r, 0));
    timers.advance(50);
    const result = await resultPromise;
    expect(result.isError).toBe(true);
    resolveLate?.({ content: [{ type: "text", text: "late" }] });
    // Give microtasks a chance to settle; no unhandled rejection expected.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("rejects invalid glob count or length with invalid_config", () => {
    const tooManyGlobs = Array.from({ length: 101 }, (_, i) => `tool${i}*`);
    expect(
      () =>
        new Gateway({
          upstreams: { github: githubUpstream },
          policy: { clients: { alice: { allow: tooManyGlobs } } },
        }),
    ).toThrow(new GatewayError("invalid_config", 'Client "alice" has more than 100 globs'));

    const longGlob = "a".repeat(201);
    expect(
      () =>
        new Gateway({
          upstreams: { github: githubUpstream },
          policy: { clients: { alice: { allow: [longGlob] } } },
        }),
    ).toThrow(
      new GatewayError(
        "invalid_config",
        'Client "alice" has a glob that is not a string or exceeds 200 characters',
      ),
    );
  });

  it("skips tools with invalid namespaced names and emits skipped_tool", async () => {
    const invalidTools: Tool[] = [
      { name: "valid", description: "", inputSchema: { type: "object" } },
      { name: "invalid name", description: "", inputSchema: { type: "object" } }, // space
      { name: "invalid/name", description: "", inputSchema: { type: "object" } }, // slash
    ];
    const weirdUpstream = createMockUpstream(invalidTools);
    policy = { clients: { alice: { allow: ["*"] } } };
    const gateway = new Gateway({
      upstreams: { weird: weirdUpstream },
      policy,
      onEvent: (e) => events.push(e),
    });
    const tools = await gateway.listTools("alice");
    expect(tools.map((t) => t.name)).toEqual(["weird__valid"]);
    expect(events.filter((e) => (e as { event?: string }).event === "skipped_tool")).toHaveLength(
      2,
    );
  });

  it("accepts a deny glob without any allow as a fail-closed policy", async () => {
    const gateway = new Gateway({
      upstreams: { github: githubUpstream, fs: fsUpstream },
      policy: { clients: { alice: { allow: [], deny: ["github__*"] } } },
      onEvent: (e) => events.push(e),
    });
    await expect(gateway.listTools("alice")).resolves.toEqual([]);
  });

  it("keeps the timeout authoritative when the upstream rejects on abort", async () => {
    policy = { clients: { alice: { allow: ["github__*"] } } };
    const timers = new ManualTimers();
    const gh = createMockUpstream(githubTools, ({ signal }) => {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const gateway = new Gateway({
      upstreams: { github: gh, fs: fsUpstream },
      policy,
      timeoutMs: 100,
      timers,
      onEvent: (e) => events.push(e),
    });
    const resultPromise = gateway.callTool("alice", "github__search", {});
    await new Promise((r) => setTimeout(r, 0));
    timers.advance(100);
    const result = await resultPromise;
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Tool call timed out" }],
    });
    expect(events).toContainEqual({
      event: "call",
      client: "alice",
      tool: "github__search",
      outcome: "timeout",
    });
  });

  it("fails closed for inherited client ids such as __proto__ and constructor", async () => {
    policy = { clients: { alice: { allow: ["*"] } } };
    const gateway = makeGateway();
    await expect(gateway.listTools("__proto__")).resolves.toEqual([]);
    await expect(gateway.listTools("toString")).resolves.toEqual([]);
    await expect(gateway.callTool("constructor", "github__search", {})).rejects.toThrow(
      new GatewayError("unknown_tool", "Unknown tool: github__search"),
    );
  });

  it("uses zod in tests to declare upstream tool schemas (demonstration)", async () => {
    const searchSchema = z.object({ q: z.string() });
    // Convert to JSON Schema for Tool.inputSchema
    const jsonSchema = z.toJSONSchema(searchSchema);
    const toolWithSchema: Tool = {
      name: "search",
      description: "Search with schema",
      inputSchema: jsonSchema as Tool["inputSchema"],
    };
    const upstream = createMockUpstream([toolWithSchema]);
    policy = { clients: { alice: { allow: ["*"] } } };
    const gateway = new Gateway({
      upstreams: { demo: upstream },
      policy,
      onEvent: (e) => events.push(e),
    });
    const tools = await gateway.listTools("alice");
    expect(tools[0]?.name).toBe("demo__search");
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });
  });
});
