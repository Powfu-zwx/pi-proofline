# pi-proofline

Record every [pi](https://pi.dev) agent run as a verifiable [proofline](https://github.com/Powfu-zwx/proofline) bundle.

After each prompt, this extension writes one JSON bundle to `.proofline/` containing the exact provider payloads pi sent, the assistant messages it got back, and every tool execution — with secrets redacted and a stable SHA-256 digest over the evidence. Anyone can then verify, diff, or sign the bundle with the proofline CLI, without trusting you or this extension.

```
you:      pi "fix the failing test"
pi:       ...does its thing...
bundle:   .proofline/pi-run-20260812-134502-4c1f09a2.json
verify:   uvx proofline verify .proofline/pi-run-20260812-134502-4c1f09a2.json
```

## Why

- **Publish sessions with evidence.** If you share your coding sessions (for example with [pi-share-hf](https://github.com/badlogic/pi-share-hf)), a bundle gives consumers something a session log cannot: a digest that detects tampering, machine-checked secret redaction, and an optional Ed25519 signature.
- **Attribute behavior changes.** Two bundles diff semantically (`proofline diff a.json b.json`), ignoring timestamps and IDs. Swap models mid-project and keep evidence of what actually changed.
- **Audit what the agent did.** The bundle records what was sent to the provider, not a reconstruction from session state.

## Install

```bash
pi install git:github.com/Powfu-zwx/pi-proofline
```

The extension is a single dependency-free TypeScript file: [`extensions/proofline.ts`](extensions/proofline.ts). Review it before installing; it should take about ten minutes.

## Use

Recording is automatic. Each run (prompt → agent settled) becomes one bundle in `.proofline/` under the project directory.

| Action | How |
|--------|-----|
| Check status | `/proofline` |
| Pause / resume recording | `/proofline off`, `/proofline on` |
| Change output directory | set `PROOFLINE_DIR` (absolute, or relative to the project) |
| Keep bundles out of git | add `.proofline/` to `.gitignore`, or commit them as baselines |

Verify, diff, and sign with the Python reference implementation:

```bash
uvx proofline verify .proofline/pi-run-*.json
uvx proofline diff baseline.json current.json
uvx proofline keygen --out signing.key
uvx proofline sign bundle.json --key signing.key
```

## What is recorded

Per model call: the full provider request payload, the finalized assistant message (including usage and cost), HTTP status, and stop reason. Per tool execution: tool name, arguments, result, and error status. Plus run context: git revision and dirty state, working directory, environment variable *names* (never values), and session ID.

Not recorded: HTTP headers (so API keys never enter the bundle), environment variable values, anything outside the run.

Redaction is pattern-based and best-effort, matching proofline's rules: secret-looking keys (`api_key`, `token`, `authorization`, ...) and secret-looking values (OpenAI/GitHub/AWS/Slack key shapes, JWTs, bearer tokens, PEM headers) are replaced with `[REDACTED]` and listed as JSON Pointers in `redactions`. `proofline verify` re-scans for leaks independently. Treat bundles as sensitive until you have reviewed them, exactly as you would a session log.

## Byte-level compatibility

The digest a verifier recomputes must match the digest this extension wrote, which requires canonical JSON to agree across languages — object key ordering (by code point), float formatting (Python `repr` rules), string escaping, and surrogate handling. This port is enforced by tests: unit tests against Python ground truth, plus a CI job that generates several hundred fuzzed vectors and a full bundle in TypeScript and verifies them with the released `proofline` package from PyPI.

## Limitations

- Auxiliary LLM calls that bypass the turn lifecycle (compaction and summarization) appear as `skipped` steps: the request is preserved, the response is not.
- Aborted turns are recorded with whatever was captured before the abort.
- Replaying a pi run through `proofline replay` is not wired up; bundles are still verifiable and diffable evidence.

## Development

```bash
npm install
npm run typecheck
npm test                # unit tests (node --test, no build step)
npm run emit-vectors    # write cross-language fixtures to out/
python tests/cross_verify.py   # requires: pip install proofline
```

## License

MIT
