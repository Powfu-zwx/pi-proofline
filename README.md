<div align="center">

# pi-proofline

**Verifiable evidence for every [pi](https://pi.dev) agent run.**

[![npm](https://img.shields.io/npm/v/pi-proofline.svg)](https://www.npmjs.com/package/pi-proofline)
[![CI](https://github.com/Powfu-zwx/pi-proofline/actions/workflows/ci.yml/badge.svg)](https://github.com/Powfu-zwx/pi-proofline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime dependencies](https://img.shields.io/badge/runtime_deps-0-success.svg)](package.json)
[![pi package](https://img.shields.io/badge/pi-package-8A2BE2.svg)](https://pi.dev)

<br>

</div>

Every prompt you give pi becomes one JSON bundle: the exact provider payloads pi sent, the assistant messages it received, every tool execution — secrets redacted, sealed under a stable SHA-256 digest. Anyone can verify, diff, or sign the bundle with the [proofline](https://github.com/Powfu-zwx/proofline) CLI. No trust in you, this extension, or pi required.

```console
$ pi "fix the failing test"
  ...
  proofline: recorded .proofline/pi-run-20260812-134502-4c1f09a2.json (digest 59279513ca52)

$ uvx proofline verify .proofline/pi-run-20260812-134502-4c1f09a2.json
OK .proofline/pi-run-20260812-134502-4c1f09a2.json
```

## How it works

```
            pi events                      capture                    evidence
 ┌─────────────────────────────┐   ┌────────────────────┐   ┌───────────────────────────┐
 │ before_provider_request ────┼──►│ request payload    │   │ .proofline/pi-run-*.json  │
 │ turn_end ───────────────────┼──►│ assistant message  ├──►│  · redacted               │
 │ tool_execution_start/end ───┼──►│ tool args, results │   │  · digest-sealed          │
 └─────────────────────────────┘   └────────────────────┘   │  · verifiable offline     │
                                                            └───────────────────────────┘
```

One run (prompt → agent settled) produces one bundle. The digest covers the evidence but not volatile fields (`run_id`, timestamps), so two runs with identical behavior share a digest — which is what makes bundles diffable and regression-testable.

## Why

**Publish sessions with proof.** If you share coding sessions — for example with [pi-share-hf](https://github.com/badlogic/pi-share-hf) — a bundle gives consumers what a session log cannot: tamper detection, machine-checked secret redaction, and an optional Ed25519 signature.

**Attribute behavior changes.** `proofline diff a.json b.json` compares runs semantically, ignoring IDs and timestamps. Swap models mid-project and keep evidence of what actually changed.

**Audit what the agent did.** The bundle records what went over the wire, captured at the provider boundary — not a reconstruction from session state.

## Install

```bash
pi install npm:pi-proofline
```

Or straight from source:

```bash
pi install git:github.com/Powfu-zwx/pi-proofline
```

The entire extension is one dependency-free TypeScript file: [`extensions/proofline.ts`](extensions/proofline.ts) (650 lines). Reviewing it before installing takes about ten minutes, and you should.

## Use

Recording is automatic. Bundles land in `.proofline/` under the project directory.

| Action | How |
|---|---|
| Check status | `/proofline` |
| Pause / resume | `/proofline off` · `/proofline on` |
| Change output directory | set `PROOFLINE_DIR` (absolute, or relative to the project) |
| Keep bundles out of git | add `.proofline/` to `.gitignore` — or commit them as baselines |

Verify, diff, and sign with the reference CLI — no pi required:

```bash
uvx proofline verify .proofline/pi-run-*.json
uvx proofline diff baseline.json current.json
uvx proofline keygen --out signing.key && uvx proofline sign bundle.json --key signing.key
```

`examples/semantic-diff-demo.ts` walks the same `diff` on canned pi events: identical reruns, a prompt change, and an inserted tool call.

## Inside a bundle

Abridged from a real run ([spec](https://github.com/Powfu-zwx/proofline/blob/master/spec/run-bundle-v0.1.md)):

```jsonc
{
  "schema_version": "0.1",
  "actor":      { "type": "human+agent", "name": "admin", "version": "0.1.0" },
  "project":    { "name": "work", "revision": "4e7018d…", "dirty": null },
  "invocation": { "argv": ["node", "…/pi", "-p", "Say hello briefly"], "cwd": "…", "env_keys": ["PATH", "…"] },
  "steps": [
    {
      "step_id": "step-1",
      "kind": "model",
      "name": "mock/gpt-mock",
      "status": "ok",
      "input":  { "model": "gpt-mock", "messages": ["…exact provider payload…"], "tools": ["…"] },
      "output": { "role": "assistant", "content": ["…"], "usage": { "totalTokens": 17, "cost": { "total": 0 } } },
      "input_digest":  "b08bdb1d…",
      "output_digest": "ae31d466…",
      "metadata": { "http_status": 200, "turn_index": 0, "stop_reason": "stop" }
    }
  ],
  "redactions": ["/steps/0/input/messages/0/content"],
  "bundle_digest": "59279513ca52…"
}
```

**Recorded** — per model call: the full request payload, the finalized assistant message, usage and cost, HTTP status, stop reason. Per tool execution: name, arguments, result, error status. Per run: git revision and dirty state, working directory, environment variable *names*, session ID.

**Never recorded** — HTTP headers (API keys never enter the bundle), environment variable *values*, anything outside the run.

**Redaction** — pattern-based and best-effort, matching proofline's rules: secret-looking keys (`api_key`, `token`, `authorization`, …) and secret-looking values (OpenAI/GitHub/AWS/Slack key shapes, JWTs, bearer tokens, PEM headers) become `[REDACTED]`, each listed as a JSON Pointer under `redactions`. `proofline verify` re-scans for leaks independently. Treat bundles as sensitive until reviewed, exactly as you would a session log.

## Byte-level compatibility

A digest is only useful if an independent verifier recomputes the same bytes. That requires canonical JSON to agree across languages, and the disagreements are where implementations usually die:

- **Key order** — Python sorts by Unicode code point, JavaScript by UTF-16 unit; they disagree beyond the BMP.
- **Float formatting** — Python `repr` writes `3e-05` where JavaScript writes `0.00003`.
- **Surrogates** — Python's encoder rejects what JavaScript strings happily carry.

This port resolves all three and proves it in CI: several hundred fuzzed vectors plus a complete bundle are generated in TypeScript on every push and verified with the released `proofline` package from PyPI. The e2e suite does the same against a real pi install.

## Limitations

- Auxiliary LLM calls that bypass the turn lifecycle (compaction, summarization) appear as `skipped` steps: request preserved, response not captured.
- Aborted turns record whatever was captured before the abort.
- `proofline replay` is not wired up for pi runs; bundles are still verifiable and diffable evidence.

## Development

```bash
npm install
npm run typecheck
npm test                       # unit tests — node --test, no build step
npm run emit-vectors           # write cross-language fixtures to out/
python tests/cross_verify.py   # requires: pip install proofline
```

End-to-end against a real pi install, no API key needed — run the mock provider, then point an isolated pi at it:

```bash
node tests/e2e/mock-provider.mjs &
export PI_CODING_AGENT_DIR=$(mktemp -d) PI_OFFLINE=1
cat > "$PI_CODING_AGENT_DIR/models.json" <<'EOF'
{ "providers": { "mock": { "baseUrl": "http://127.0.0.1:8377/v1", "api": "openai-completions",
  "apiKey": "dummy", "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
  "models": [ { "id": "gpt-mock" } ] } } }
EOF
pi -p --no-session --provider mock --model gpt-mock -e ./extensions/proofline.ts "Say hello"
uvx proofline verify .proofline/pi-run-*.json
```

## See also

- [proofline](https://github.com/Powfu-zwx/proofline) — the protocol and reference implementation: verify, diff, replay, sign
- [Run bundle spec](https://github.com/Powfu-zwx/proofline/blob/master/spec/run-bundle-v0.1.md) — format and verification rules
- [pi](https://pi.dev) — the coding agent this extends

## License

[MIT](LICENSE)
