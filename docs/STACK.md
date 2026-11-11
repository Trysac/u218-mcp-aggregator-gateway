# Stack

## Used

| Tool | Purpose | Why |
|---|---|---|
| TypeScript | Language and type checking | Public API types and declarations for consumers. |
| Node.js 20+ | Runtime | ESM package runtime. |
| `@modelcontextprotocol/sdk` ^1.23.0 | MCP server/client types and low-level `Server` | Required by the implementation and tests. |
| Vitest | Tests | `test/index.test.ts` imports `describe`, `it`, `expect` and `vi` from `vitest`. |
| `zod` ^4.1.0 (dev) | Test tool schemas | Used in `test/index.test.ts` to declare an upstream tool schema. |

## Discarded

No discarded tool is recorded in the code or specification.
