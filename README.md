# @trysac/mcp-aggregator-gateway

An MCP gateway that aggregates tools from multiple upstream MCP servers under namespaced names, with a fail-closed per-client access policy, timeouts, and sanitised errors. Built on the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) (1.x).

## Installation

```bash
npm install @trysac/mcp-aggregator-gateway
```

## Usage

```typescript
import { Gateway, type Upstream } from "@trysac/mcp-aggregator-gateway";
declare const githubClient: Upstream;
declare const fsClient: Upstream;
const gateway = new Gateway({
  upstreams: { github: githubClient, fs: fsClient },
  policy: { clients: { alice: { allow: ["github__*"], deny: ["github__create_*"] } } },
});
const server = gateway.connect("alice");
```

All tools are exposed as `<server>__<tool>`. Policies use anchored, case-sensitive globs where `*` is the only wildcard and matches any sequence, including the separator. Hidden and unknown tools are indistinguishable to the caller.

## Why not configuring each server in the client

Configuring each upstream server in every client repeats per-server settings and cannot enforce a per-client policy at one reviewable point. This gateway exposes one MCP server whose tool list and tool calls are filtered by the same `AccessPolicy`.

## Security

See [`docs/SECURITY.md`](docs/SECURITY.md) for the threat model.

## API

### `new Gateway(opts)`

- `opts.upstreams`: `Record<string, Upstream>` — server name to SDK `Client` or compatible object.
- `opts.policy`: `AccessPolicy` — `clients` maps a client ID to `{ allow: string[]; deny?: string[] }`.
- `opts.timeoutMs` (default `30000`): timeout for upstream `listTools` and `callTool`.
- `opts.maxResultBytes` (default `1048576`): maximum UTF-8 byte length of the JSON serialisation of a tool result.
- `opts.timers` (optional): injectable `setTimeout` and `clearTimeout` used by the timeout paths.
- `opts.onEvent` (optional): receives `GatewayEvent` payloads.

The constructor throws `GatewayError` with code `invalid_config` when a server name does not match `^[a-z0-9-]{1,32}$`, when a client has no `allow` array or a non-array `deny`, when a client has more than 100 globs, when a glob is not a string or exceeds 200 characters, or when `timeoutMs` or `maxResultBytes` is not positive.

### `gateway.refresh()`

Re-fetches tool lists from all upstreams. Failed upstreams are omitted until a later refresh succeeds and emit `{ event: "upstream_unavailable", server }`.

### `gateway.listTools(clientId)`

Returns visible namespaced tools for the client, sorted ascending. A tool is visible when the client exists in the policy, the namespaced name matches at least one allow glob, and it matches no deny glob. Unknown clients receive `[]`.

### `gateway.callTool(clientId, name, args)`

Calls a visible tool. Hidden and unknown tools throw `GatewayError` with code `unknown_tool` and message `Unknown tool: <name>` (the name is truncated to 128 characters). The upstream receives the original tool name and an `AbortSignal`. On timeout the signal is aborted and the call returns `{ isError: true, content: [{ type: "text", text: "Tool call timed out" }] }`. Upstream exceptions and non-serialisable results return `{ isError: true, content: [{ type: "text", text: "Tool call failed" }] }`. Results whose JSON exceeds `maxResultBytes` return `{ isError: true, content: [{ type: "text", text: "Tool result too large" }] }`. Otherwise the upstream result is returned unchanged.

### `gateway.connect(clientId)`

Returns an MCP `Server` bound to that client identity. It exposes `tools/list` and `tools/call`; `unknown_tool` maps to `McpError(ErrorCode.InvalidParams)` (JSON-RPC `-32602`).

### `GatewayError`

Extends `Error` with `code: "invalid_config" | "unknown_tool"`.

### `GatewayEvent`

`GatewayEvent` is one of `{ event: "call"; client: string; tool: string; outcome: "ok" | "denied" | "error" | "timeout" | "too_large" }`, `{ event: "skipped_tool"; server: string }`, or `{ event: "upstream_unavailable"; server: string }`. Call events never contain arguments or results.

The public API handles only tools (`tools/list`, `tools/call`); resources, prompts, sampling and HTTP transport setup are not implemented.

## License

MIT
