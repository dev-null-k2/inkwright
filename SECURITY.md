# Security policy

Inkstone handles people's private notes and gives AI agents access to them, so we treat security
reports as the most important issues we get. Thank you for helping.

## Reporting a vulnerability

- **Privately**, please: use GitHub's [private vulnerability reporting](../../security/advisories/new)
  for this repository. Don't open a public issue, pull request or discussion for a suspected
  vulnerability.
- Include what you found, how to reproduce it (a vault, a request, a note's content), what an
  attacker gains, and the version or commit. A proof of concept helps; please don't access other
  people's data to make one.
- We acknowledge within **3 working days**, give a first assessment within **10 working days**,
  and keep you updated until it is fixed. We aim to release fixes for high and critical issues
  within **30 days**, and to credit you in the advisory unless you prefer otherwise.

## Scope

In scope: the web app and PWA, the Android and iOS shells, `@inkstone/core`, `@inkstone/ai`,
`@inkstone/sync`, the MCP server / A2A agent / runner (`apps/mcp-server`), the Docker appliance
(`deploy/`), and the documented vault format.

Especially interesting:

- reading or changing notes outside what a token, OAuth scope or the AI policy allows (hidden or
  read-only notebooks, local-only notes reaching a cloud provider, locked notes);
- path traversal, symlink escapes or injection through ids, asset names, resource URIs or vault
  files written by another device;
- prompt injection that makes an agent change or send data **without** the confirmation the
  trust layer promises (see docs/TRUST.md for what is and isn't promised);
- personal data or secrets leaving the device when the privacy firewall says it redacts them;
- forging or silently editing the audit trail or authorship certificates;
- API keys or tokens readable by scripts, logged, or synced.

Out of scope: attacks that need an already-compromised device or browser profile, a user pasting
their own key somewhere public, the security of the AI providers or MCP servers a user chooses to
connect, and findings from automated scanners without a demonstrated impact.

## Supported versions

Security fixes go to the latest release and `main`. The appliance images are rebuilt for every
release; pin by digest and update when an advisory is published.

## How we keep the code safe

- CodeQL and Semgrep on every push (`.github/workflows/security.yml`), secret scanning with
  gitleaks (`.gitleaks.toml`), and a dependency audit that fails on high/critical advisories in
  shipped packages (`npm run audit:deps`).
- A CycloneDX SBOM for every build (`npm run sbom`, attached to releases).
- Tests for the attack surface: `apps/mcp-server/test/trust.test.ts` (hostile ids on every tool,
  resource URIs, symlinks, body limits, health endpoint, policy enforcement) and the existing
  auth, OAuth, Host/Origin (DNS rebinding) tests; `packages/ai/evals/trust.eval.ts` for the
  privacy firewall and prompt-injection defences, with published misses.
- The threat model is in [docs/ENTERPRISE.md](docs/ENTERPRISE.md#threat-model).
