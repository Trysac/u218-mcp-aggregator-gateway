# Use low-level MCP Server with namespaced tools and per-client policy

Status: accepted (generated, pending human review)

## Context

Agents need tools from multiple MCP servers without manual per-server configuration, and every client should only see and call allowed tools.

## Decision

Implement a `Gateway` class that aggregates upstream tools under `<server>__<tool>` names, applies allow/deny glob policies, and exposes a single MCP endpoint via the SDK's low-level `Server`. Use injected timers for deterministic timeouts and sanitise all upstream errors.

## Consequences

Clients connect to one endpoint. Policies are centralised and fail closed. Upstream failures are isolated and recover on refresh. The gateway does not handle resources/prompts and trusts the caller for client identity.
