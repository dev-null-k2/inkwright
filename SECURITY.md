# Security policy

Inkwright handles people's private notes and gives AI agents access to them, so we treat security
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
- We publish fixed issues as GitHub security advisories (with a CVE where it applies) once a
  fixed release is out on the web, on Google Play and as a GitHub release. Please give us the
  time above before disclosing; if 90 days pass without a fix, you may publish, and we will say
  so in the advisory.
- Safe harbour: research in good faith within this policy — on your own devices, vaults and
  servers — is welcome, and we will not pursue it.

## Scope

In scope: the web app and PWA, the Android and iOS shells, `@inkwright/core`, `@inkwright/ai`,
`@inkwright/sync`, the MCP server / A2A agent / runner (`apps/mcp-server`), the Docker appliance
(`deploy/`), and the documented vault format.

Especially interesting:

- reading or changing notes outside what a token, OAuth scope, plugin permission or the AI policy
  allows (hidden or read-only notebooks, local-only notes reaching a cloud provider, locked notes,
  a plugin's note scope);
- code running in the app's origin, or a plugin, runbook block or data-sandbox query reaching the
  network or storage it should not;
- anything that can write the vault (a sync remote, a paired device, a backup) making code run or
  credentials appear on a device without that device's consent;
- path traversal, symlink escapes or injection through ids, asset names, resource URIs or vault
  files written by another device;
- prompt injection that makes an agent change or send data **without** the confirmation the
  trust layer promises (see docs/TRUST.md for what is and isn't promised);
- personal data or secrets leaving the device when the privacy firewall says it redacts them;
- forging or silently editing the audit trail or authorship certificates;
- API keys or tokens readable by scripts, logged, synced, or copied off the device (backups);
- Android: exported components, intents or files that let another app read or plant data.

Out of scope: attacks that need an already-compromised device or browser profile, a user pasting
their own key somewhere public, the security of the AI providers or MCP servers a user chooses to
connect, and findings from automated scanners without a demonstrated impact.

## Supported versions

| What | Supported |
|---|---|
| Web app (hosted) and PWA | the deployed version; it updates itself |
| Android app (Google Play, GitHub releases) | the latest release; Play rolls fixes out to everyone |
| `@inkwright/*` packages, `inkwright-mcp`, `inkwright-agent` | the latest minor release and `main` |
| Docker appliance (`deploy/`) | images of the latest release; pin by digest and update when an advisory is published |

Older releases don't get backported fixes: update to the latest.

## How we keep the code safe

- CodeQL and Semgrep on every push (`.github/workflows/security.yml`), secret scanning with
  gitleaks (`.gitleaks.toml`), and a dependency audit that fails on high/critical advisories in
  shipped packages (`npm run audit:deps`).
- GitHub Actions pinned to commit SHAs (checked on every push), read-only tokens by default, and
  a release job that builds without write access or persisted credentials and deletes the signing
  key after use; Dependabot keeps actions and dependencies current.
- A CycloneDX SBOM for every build (`npm run sbom`, attached to releases).
- Tests for the attack surface: `apps/mcp-server/test/trust.test.ts` (hostile ids on every tool,
  resource URIs, symlinks, body limits, health endpoint, policy enforcement) and the existing
  auth, OAuth, Host/Origin (DNS rebinding) tests; `packages/ai/evals/trust.eval.ts` for the
  privacy firewall and prompt-injection defences, with published misses.
- Proofs of concept from security reviews stay as tests: `apps/web/e2e/security.spec.ts` and the
  `SR-` tests named in the review.
- The threat model and the latest independent review are in
  [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) (November 2026: findings, fixes, accepted
  risks); the server deployment's threat model is in
  [docs/ENTERPRISE.md](docs/ENTERPRISE.md#threat-model).
