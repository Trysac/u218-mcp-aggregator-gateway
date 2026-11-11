# Security

## Threat Model

### Defended

- **Tool discovery beyond policy**: Clients only see tools matching their allow globs and not matching any deny glob. Unknown clients see no tools.
- **Calls to hidden tools**: Hidden, denied, and unknown tool names return the same `GatewayError` code `unknown_tool`; through `connect` this is `McpError(ErrorCode.InvalidParams)` (JSON-RPC `-32602`). A name matching an allow glob but not present in the cached tool list is rejected without calling the upstream.
- **Name collisions between servers**: Tools are namespaced as `<server>__<tool>`, so servers with the same tool name do not clash.
- **Leaking upstream error details**: Upstream exceptions and results that cannot be JSON-serialised are replaced with the fixed `"Tool call failed"` result; event payloads contain client, tool and outcome but no arguments or results.
- **Hung upstreams**: `listTools` and `callTool` race the injected timer. On `callTool` timeout the upstream `AbortSignal` is aborted, the timeout outcome remains authoritative if the upstream rejects on abort, and a late result is ignored.
- **Oversized results**: Results whose JSON UTF-8 byte length exceeds `maxResultBytes` (default `1_048_576`) are replaced with `"Tool result too large"`.
- **Invalid configuration**: Server names must match `^[a-z0-9-]{1,32}$`. Each client must have an `allow` array and, if present, a `deny` array, with at most 100 globs and no glob longer than 200 characters. `timeoutMs` and `maxResultBytes` must be positive.
- **Malformed upstream tool entries**: Entries without a string `name`, or whose namespaced name does not match `^[A-Za-z0-9_.-]{1,128}$`, are skipped and emit `{ event: "skipped_tool", server }`. Malformed `listTools` payloads emit `{ event: "upstream_unavailable", server }`.
- **Inherited client IDs**: Policy lookup uses `Object.hasOwn`, so client IDs such as `__proto__` and `constructor` fail closed.

### Not Defended

- **Malicious upstream tool descriptions**: Tool metadata (descriptions, schemas, annotations) is passed through; clients must treat it as untrusted (prompt injection).
- **Client authentication**: The caller must supply a trustworthy `clientId` (for example from a transport or auth layer). This library does not authenticate clients.
- **Resource and prompt primitives**: The gateway handles only tools (`tools/list`, `tools/call`). Resources, prompts, sampling and HTTP transport setup are outside the gateway.
- **Rate limiting and quotas**: No rate limiting or quota enforcement is implemented.
