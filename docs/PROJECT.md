# Project record: mcp-aggregator-gateway

## Objective

MCP gateway that aggregates the tools of several upstream MCP servers under namespaced names, with per-client allow and deny globs, timeouts and sanitised errors. It provides one MCP endpoint whose tool list and tool calls are filtered by a reviewable `AccessPolicy`.

## Scope

In scope:

- Aggregating tool lists from multiple upstream MCP servers.
- Namespacing tools as `<server>__<tool>` to avoid collisions between servers.
- Per-client allow and deny globs with anchored, case-sensitive `*` matching.
- Lazy tool discovery, explicit `refresh()`, and omission of unavailable upstreams until recovery.
- Upstream timeouts with `AbortSignal`, result size limits, and sanitised errors.
- An MCP `Server` for `tools/list` and `tools/call` bound to a client identity.

Out of scope:

- Resources, prompts, sampling, and HTTP transport setup.
- Client authentication; the caller supplies a trustworthy `clientId`.
- Rate limiting or quotas.
- Validating or sanitising upstream tool descriptions, schemas, or annotations against prompt injection.

## Timeline

| Date | Milestone |
|---|---|
| 2026 | Repository created from the factory utility template. |

## Effort metrics

Values are recorded from the factory ledger and time log.

| Metric | Value | Source |
|---|---|---|
| Tokens (input / output) | 2858509 / 108087 | factory ledger |
| Hours (human) | pending measurement | time log |
| Cost (USD) | 0.1280 | factory ledger |

## Factory run u218 (measured from API usage)

| Date (UTC) | Phase | Model | Batch | Input | Output | Cache write | Cache read | Cost (USD) |
|---|---|---|---|---|---|---|---|---|
| 2026-11-11 | generation | deepseek-v4-pro | yes | 5339 | 19783 | 0 | 0 | 0.0427 |
| 2026-11-11 | fix-1 | deepseek-flash | no | 30537 | 13877 | 0 | 749440 | 0.0152 |
| 2026-11-11 | audit | deepseek-flash | no | 28677 | 23193 | 0 | 741760 | 0.0204 |
| 2026-11-11 | fix-2 | deepseek-flash | no | 11077 | 6222 | 0 | 128896 | 0.0058 |
| 2026-11-11 | threat-model | deepseek-flash | no | 20117 | 11382 | 0 | 148864 | 0.0103 |
| 2026-11-11 | fix-3 | deepseek-flash | no | 15350 | 10101 | 0 | 181120 | 0.0089 |
| 2026-11-11 | fix-4 | deepseek-flash | no | 40874 | 10757 | 0 | 740736 | 0.0148 |
| 2026-11-11 | docs | deepseek-flash | no | 15338 | 12772 | 0 | 384 | 0.0100 |

Total: $0.1280. Prices: deepseek line, as measured by its adapter. Providers serve the current version of each model id, so the date tells which version answered; versions, launch stages and price sources per line are in the factory's model register (docs/MODELS.md).
