# Testing

## Tools

- [Vitest](https://vitest.dev/) runs `test/index.test.ts`.
- The test file uses `InMemoryTransport.createLinkedPair()` and `Client` from `@modelcontextprotocol/sdk`, and `z` from `zod` for one schema demonstration.

## Commands

```sh
npx vitest run test/index.test.ts
npx vitest
```

## Rules

- Tests import from `../src/index.js` and assert observable behavior: returned tool lists, returned `CallToolResult` objects, thrown `GatewayError` codes/messages, and emitted `onEvent` payloads.
- Timeout tests inject a `ManualTimers` implementation of `Timers` and advance it explicitly.
- Upstreams are `vi.fn` mocks created by `createMockUpstream`; no network is used.

## Tiers

The repository contains one local test file, `test/index.test.ts`. It has no separate conformance tier or external-tool fixtures.

## Reports

No coverage reporting configuration is present in the reviewed code.

## What `test/index.test.ts` covers

- Tool visibility: allow globs, deny globs, unknown clients, inherited client IDs, sorted results, and a deny glob with an empty allow list.
- Calls: forwarding the original tool name and arguments, returning the upstream result unchanged, rejecting hidden/non-existent tools without calling the upstream, and mapping `unknown_tool` to JSON-RPC `-32602` through an SDK `Client`.
- Failure handling: sanitising upstream exceptions, non-serialisable results, and events that contain no arguments or results.
- Timeouts: aborting the upstream signal, keeping the timeout authoritative when the upstream rejects on abort, ignoring a late result, and timing out a hung upstream during discovery.
- Limits and validation: `maxResultBytes`, invalid server names, too many globs, overlong globs, invalid namespaced tool names, and malformed upstream `listTools` payloads.
- Namespacing and refresh: collisions between servers, recovery after an upstream failure, and a schema declared with `zod` in a test upstream.
