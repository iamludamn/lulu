# 004. Serialize MCP credential updates and distinguish explicit sign-in

## Context

OAuth state for all MCP connections owned by a bot shares one encrypted document. Updating two records concurrently can lose one update because each operation reads and rewrites the document. A user can also explicitly request sign-in while a stored grant can still be refreshed.

## Decision

Serialize credential mutations at the shared storage boundary, including mutations for different MCP servers. An explicit sign-in skips token refresh and opens the provider's authorization flow. Normal connection handling can reuse or refresh the stored grant.

Configured header strings support both `${VAR}` and `$VAR` substitution from the runtime environment. Other text remains literal. This format lets configuration refer to a secret supplied by the environment without embedding the secret itself.

## References

- [Credential storage lock](../../core/src/agent/mcp-auth.ts), [explicit sign-in](../../core/src/agent/mcp-oauth.ts), and [header resolution](../../core/src/agent/mcp.ts)
