# Contributing

Bug reports, focused improvements, and documentation corrections are welcome. Open an issue before a substantial behavior or architecture change so maintainers can discuss the scope. For vulnerabilities, follow [Security](../SECURITY.md).

## Development

Start with the prerequisites and build in [README](../README.md), then follow [deployment](deployment.md) for a local Worker. Keep credentials in a secret manager and inject them at runtime. `.env.index` lists variable names only; never commit credentials, conversation exports, or unredacted telemetry.

For web development, run the Worker first, then `npm run dev -w @lulu/client`. Vite proxies `/api`, including WebSockets, to `http://127.0.0.1:8787`. Set `LULU_WORKER_URL` to use another local Worker address.

For desktop development, run `npm run dev --prefix client/desktop` on a supported graphical host. For iOS, open `client/ios/PiStack.xcodeproj` in Xcode, choose your own signing team, and select an iOS 26 simulator or device. Configure your own server in the native clients. The desktop client defaults to the local Worker; iOS asks for a server on first launch.

## Design conventions

- Start from the data structures and keep each change focused.
- Use official Pi packages and existing extension points before adding custom mechanisms.
- Keep durable core logic free of OS and filesystem dependencies.
- Declare tool replay behavior and make external side effects idempotent by request ID.
- Keep recoverable state in Docs and model-visible context in sections.
- Keep modules aligned with the existing feature boundaries; avoid speculative abstractions.
- Do not add code comments. Keep names and implementation clear.
- Keep documentation concise and grounded in code. Put architecture, contributor, community, and operational guides in `docs/`.

## Validation

Run checks appropriate to the change and record the results in the PR:

```sh
npm run check
npm run lint
npm run build
```

The root build produces the core, web app, and desktop binary. It does not validate an iOS build or external-service behavior. Existing CI additionally runs `npm test` and desktop cross-compilation. Unit tests are not required for contributions; discuss additional tests with maintainers rather than adding them by default. Documentation changes should be checked for accurate commands, working relative links, and sensitive information.

## Pull requests

Branch from current `main` using `<type>/<short-kebab-description>`. Use English for repository text, including commits and PRs. Use Conventional Commits, for example `docs: add self-hosting instructions` or `fix(core): preserve replay state`. Keep titles imperative, lowercase, and at most 72 characters. Scope is `core`, `cf`, `web`, or `ios`; omit it for repository-wide work.

Explain the problem, resulting behavior, and verification. Note any limitations, especially unverified native clients or external integrations. Screenshots help when UI behavior changes. Do not include secrets or private user data. Maintainers review and squash-merge changes into `main`.

By contributing, you agree to license your contribution under the repository's [MIT license](../LICENSE). Retain required third-party notices and disclose newly introduced dependencies.
