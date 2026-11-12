# Security policy

## Deployment boundary

lulu is currently designed for a trusted single user. There is no general API authentication or tenant isolation. Conversation WebSockets, memory reads, schedules, artifact downloads, and space state are not protected by the MCP registry token. Anyone who can reach these routes may access data or trigger actions with the deployment's credentials.

Protect the entire service with a private network or an authenticated gateway covering HTTP and WebSockets. Ensure that alternate origins, including the default Workers hostname, cannot bypass that boundary. Native clients must support the chosen gateway; lulu does not implement a gateway login flow. Do not expose an unprotected deployment to the public internet.

`MCP_ADMIN_TOKEN` protects registry management only. MCP configuration and authorization are encrypted using `MCP_ENCRYPTION_KEY`; this does not encrypt all conversation, memory, or artifact data. Back up the key securely: replacing it without migrating stored ciphertext makes existing encrypted records unreadable.

Models, tools, MCP servers, sandboxes, object storage, and telemetry are separate trust boundaries. Give integrations minimal privileges. Restrict telemetry access, define retention, and redact logs before sharing them. Agent-generated output and tool results are untrusted input.

## Supported code

Security fixes target the current `main` branch. There is no supported release series or guaranteed response time yet.

## Reporting a vulnerability

Do not put exploit details, credentials, or private data in a public issue or PR. Use [GitHub private vulnerability reporting](https://github.com/iamludamn/lulu/security/advisories/new) when the repository offers it. If that option is unavailable, open an issue asking only for a private security contact, without disclosing the vulnerability. See GitHub's [private reporting guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

In a private report, include the affected commit, impact, prerequisites, and a minimal reproduction with synthetic data. Coordinate disclosure with maintainers. If a credential was exposed, revoke or rotate it immediately; removing a file does not remove it from Git history.

## Before making a fork or deployment public

Review the entire Git history and binary assets for credentials and private data, not just the current tree. Replace maintainer-specific Worker names, KV identifiers, telemetry destinations, and client server defaults with your own configuration. Enable private vulnerability reporting and review repository access, branch protections, Actions permissions, and deployment secrets in GitHub settings. These settings are not applied by this policy file.
