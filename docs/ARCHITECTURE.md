# Architecture

The public entry point is `src/index.ts`. `Gateway` stores upstreams, policy, timeout, max result size, timers, and event callback. The constructor validates server names, client policy arrays, glob count/length, and positive limits, throwing `GatewayError` with code `invalid_config`.

Tool lists are cached in `Map<string, Tool[]>`. `loadTools` deduplicates concurrent refreshes with `refreshPromise`; `performRefresh` calls `listTools()` on every upstream concurrently with `Promise.allSettled` and a per-upstream timeout. A failed or malformed upstream is omitted and emits `upstream_unavailable`. Tools are namespaced as `<server>__<tool>`; entries without a string name or with a namespaced name outside `^[A-Za-z0-9_.-]{1,128}$` are skipped and emit `skipped_tool`.

Policy evaluation is pure: a namespaced name is visible when the client exists via `Object.hasOwn`, at least one allow glob matches, and no deny glob matches. Globs are anchored and case-sensitive with `*` matching any sequence, including the separator.

`callTool` checks visibility, splits the namespaced name at the first `__`, verifies the original tool is in the cached list for that server, and invokes the upstream with the original tool name, arguments and an `AbortSignal`. The upstream promise races the injected timer. On timeout the signal aborts and the timeout outcome wins; a late result is ignored. Results are JSON-serialised for size checking; non-serialisable results and upstream exceptions return a fixed error result.

`connect(clientId)` creates a low-level SDK `Server` named `mcp-aggregator-gateway` with `capabilities: { tools: {} }`. It registers `tools/list` and `tools/call`; `GatewayError` with code `unknown_tool` is mapped to `McpError(ErrorCode.InvalidParams)`.
