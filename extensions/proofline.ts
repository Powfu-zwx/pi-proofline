/**
 * pi-proofline: record every pi agent run as a verifiable proofline bundle.
 *
 * Each run (user prompt -> agent settled) becomes one JSON bundle under
 * .proofline/ containing the exact provider payloads, assistant messages,
 * and tool executions, with secrets redacted and a stable SHA-256 digest.
 * Bundles verify with the Python reference implementation:
 *
 *   uvx proofline verify .proofline/<bundle>.json
 *
 * This file is self-contained and has no runtime dependencies. The canonical
 * JSON, digest, and redaction logic below are a byte-compatible port of
 * proofline's Python implementation (https://github.com/Powfu-zwx/proofline);
 * parity is enforced by cross-language tests in this repository.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import * as path from "node:path";

export const VERSION = "0.1.0";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// ---------------------------------------------------------------------------
// Canonical JSON (parity with proofline.model.canonical_json)
//
// Python: json.dumps(value, sort_keys=True, separators=(",", ":"),
//                    ensure_ascii=False, allow_nan=False)
// The digest is computed over the canonical form of the *parsed* file, so the
// serializer here must produce exactly what Python produces after a JSON
// round-trip of the same document.
// ---------------------------------------------------------------------------

/** Python compares strings by Unicode code point; JS `<` compares UTF-16 units. */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return a.length - i === b.length - j ? 0 : a.length - i < b.length - j ? -1 : 1;
}

/**
 * Serialize a number the way Python's json module renders the value after
 * parsing this document back: integers stay plain digits, floats follow
 * Python's repr rules (fixed notation for 1e-4 <= |x| < 1e16, otherwise
 * scientific with a sign and a zero-padded two-digit exponent).
 */
export function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("bundle values must be finite numbers (no NaN/Infinity)");
  }
  if (Number.isInteger(value) && Math.abs(value) < 1e21) {
    // Serialized without an exponent, so Python parses it as int.
    return JSON.stringify(value);
  }
  const exponential = value.toExponential();
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exponential);
  if (!match) throw new TypeError(`unexpected exponential form: ${exponential}`);
  const sign = match[1] as string;
  const first = match[2] as string;
  const fraction = match[3] ?? "";
  const exp10 = Number(match[4]);
  if (exp10 < -4 || exp10 >= 16) {
    const mantissa = fraction ? `${first}.${fraction}` : first;
    const expSign = exp10 < 0 ? "-" : "+";
    const expDigits = String(Math.abs(exp10)).padStart(2, "0");
    return `${sign}${mantissa}e${expSign}${expDigits}`;
  }
  const digits = first + fraction;
  if (exp10 >= 0) {
    // Non-integral (integers took the branch above), so digits extend past
    // the decimal point.
    const intLength = exp10 + 1;
    return `${sign}${digits.slice(0, intLength)}.${digits.slice(intLength)}`;
  }
  return `${sign}0.${"0".repeat(-exp10 - 1)}${digits}`;
}

const STRING_ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** Python ensure_ascii=False: escape only quotes, backslash, and C0 controls. */
export function canonicalString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const escape = STRING_ESCAPES[ch];
    if (escape !== undefined) {
      out += escape;
    } else {
      const code = ch.codePointAt(0) as number;
      out += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
    }
  }
  return out + '"';
}

export function canonicalJson(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value === "string") return canonicalString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort(compareCodePoints);
  const parts = keys.map((key) => `${canonicalString(key)}:${canonicalJson(value[key] as Json)}`);
  return `{${parts.join(",")}}`;
}

export function sha256Json(value: Json): string {
  return createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex");
}

// Signatures attest to a bundle; they are not recorded evidence, so they are
// excluded from the stable digest (parity with proofline.model).
const VOLATILE_TOP_LEVEL = new Set(["run_id", "created_at", "bundle_digest", "signatures"]);
const VOLATILE_STEP_FIELDS = new Set(["started_at", "ended_at"]);

export function stableBundle(bundle: JsonObject): JsonObject {
  const normalized: JsonObject = {};
  for (const [key, value] of Object.entries(bundle)) {
    if (!VOLATILE_TOP_LEVEL.has(key)) normalized[key] = value;
  }
  const steps = Array.isArray(bundle.steps) ? bundle.steps : [];
  normalized.steps = steps.map((step) => {
    const slim: JsonObject = {};
    for (const [key, value] of Object.entries(step as JsonObject)) {
      if (!VOLATILE_STEP_FIELDS.has(key)) slim[key] = value;
    }
    return slim;
  });
  return normalized;
}

export function stableDigest(bundle: JsonObject): string {
  return sha256Json(stableBundle(bundle));
}

// ---------------------------------------------------------------------------
// Capture-boundary sanitization
//
// Event payloads come from pi at the same trust level as the data it sends to
// providers, but they may contain values JSON cannot carry (undefined, NaN,
// unpaired surrogates). Python's encoder crashes on unpaired surrogates, so
// they are replaced with U+FFFD here, at the capture boundary.
// ---------------------------------------------------------------------------

const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function fixSurrogates(value: Json): Json {
  if (typeof value === "string") return value.replace(UNPAIRED_SURROGATE, "\uFFFD");
  if (Array.isArray(value)) return value.map(fixSurrogates);
  if (value !== null && typeof value === "object") {
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      result[key.replace(UNPAIRED_SURROGATE, "\uFFFD")] = fixSurrogates(child);
    }
    return result;
  }
  return value;
}

export function jsonSafe(value: unknown): Json {
  if (value === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(value); // drops undefined/functions, maps NaN/Infinity to null
  } catch (error) {
    return { proofline_capture_error: String(error) };
  }
  if (text === undefined) return null;
  return fixSurrogates(JSON.parse(text) as Json);
}

// ---------------------------------------------------------------------------
// Redaction (parity with proofline.redact)
// ---------------------------------------------------------------------------

export const REDACTED = "[REDACTED]";

// "token" stays singular: plural keys such as "max_tokens" are counts.
const SECRET_KEY =
  /(^|[_\-.])(api[_-]?keys?|auth|token|secrets?|passwords?|authorization|credentials?|private[_-]?keys?)(?=$|[_\-.])/i;
const SECRET_VALUE =
  /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function escapePointer(part: string): string {
  return part.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function redact(value: Json): { value: Json; redactions: string[] } {
  const redactions: string[] = [];

  function walk(node: Json, pointer: string): Json {
    if (node !== null && typeof node === "object" && !Array.isArray(node)) {
      const result: JsonObject = {};
      for (const [key, child] of Object.entries(node)) {
        const childPointer = `${pointer}/${escapePointer(key)}`;
        if (SECRET_KEY.test(key) && child !== null) {
          result[key] = REDACTED;
          redactions.push(childPointer);
        } else {
          result[key] = walk(child, childPointer);
        }
      }
      return result;
    }
    if (Array.isArray(node)) {
      return node.map((child, index) => walk(child, `${pointer}/${index}`));
    }
    if (typeof node === "string" && SECRET_VALUE.test(node)) {
      redactions.push(pointer || "/");
      return REDACTED;
    }
    return node;
  }

  return { value: walk(value, ""), redactions };
}

// ---------------------------------------------------------------------------
// Run recorder (parity with proofline.recorder.RunRecorder)
// ---------------------------------------------------------------------------

function utcNow(): string {
  return new Date().toISOString();
}

function git(args: string[], cwd: string): string | null {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      timeout: 5000,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function qualifyRedactions(paths: string[], prefix: string): string[] {
  return paths.map((p) => (p === "/" ? prefix : `${prefix}${p}`));
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

interface StepDraft {
  kind: "model" | "tool";
  name: string;
  status: "ok" | "error" | "skipped";
  started_at: string;
  ended_at: string | null;
  input: Json;
  output: Json;
  error: string | null;
  cost: Json;
  metadata: JsonObject;
  sealed: boolean;
}

export interface RecorderOptions {
  cwd: string;
  metadata?: JsonObject;
}

export class Recorder {
  readonly cwd: string;
  private readonly steps: StepDraft[] = [];
  private redactions: string[];
  private readonly metadata: Json;
  private readonly project: JsonObject;
  private readonly invocation: JsonObject;
  private readonly actor: JsonObject;

  constructor(options: RecorderOptions) {
    this.cwd = options.cwd;
    const { value: metadata, redactions } = redact(options.metadata ?? {});
    this.metadata = metadata;
    this.redactions = qualifyRedactions(redactions, "/metadata");

    const revision = git(["rev-parse", "HEAD"], this.cwd);
    const dirty = git(["status", "--porcelain"], this.cwd);
    this.project = {
      name: path.basename(this.cwd) || this.cwd,
      revision,
      // Parity with the Python recorder: a clean tree and a missing repo both
      // yield null; only a non-empty `git status --porcelain` yields true.
      dirty: dirty === null ? null : true,
    };
    this.invocation = {
      argv: process.argv.slice(),
      cwd: this.cwd,
      env_keys: Object.keys(process.env).sort(compareCodePoints),
      node: process.version,
    };
    let username: string;
    try {
      username = userInfo().username;
    } catch {
      username = process.env.USERNAME ?? process.env.USER ?? "unknown";
    }
    this.actor = { type: "human+agent", name: username, version: VERSION };
  }

  get stepCount(): number {
    return this.steps.length;
  }

  beginModelStep(name: string, input: unknown): number {
    const index = this.steps.length;
    this.steps.push({
      kind: "model",
      name,
      status: "ok",
      started_at: utcNow(),
      ended_at: null,
      input: jsonSafe(input), // frozen snapshot; later mutation cannot alter evidence
      output: null,
      error: null,
      cost: null,
      metadata: {},
      sealed: false,
    });
    return index;
  }

  annotate(index: number, patch: JsonObject): void {
    const step = this.steps[index];
    if (!step || step.sealed) return;
    Object.assign(step.metadata, patch);
  }

  completeModelStep(index: number, message: unknown): void {
    const step = this.steps[index];
    if (!step || step.sealed) return;
    const output = jsonSafe(message);
    step.output = output;
    if (output !== null && typeof output === "object" && !Array.isArray(output)) {
      const stopReason = output.stopReason;
      if (typeof stopReason === "string") {
        step.metadata.stop_reason = stopReason;
        if (stopReason === "error") {
          step.status = "error";
          step.error =
            typeof output.errorMessage === "string"
              ? output.errorMessage
              : "provider reported an error";
        } else if (stopReason === "aborted") {
          step.status = "error";
          step.error = "aborted before the response completed";
        }
      }
      const usage = output.usage;
      if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
        const cost = (usage as JsonObject).cost;
        if (cost !== null && typeof cost === "object" && !Array.isArray(cost)) {
          step.cost = cost;
        }
      }
    }
    this.seal(index);
  }

  addToolStep(entry: {
    name: string;
    input: unknown;
    output: unknown;
    isError: boolean;
    startedAt?: string;
    metadata?: JsonObject;
  }): void {
    const index = this.steps.length;
    this.steps.push({
      kind: "tool",
      name: entry.name,
      status: entry.isError ? "error" : "ok",
      started_at: entry.startedAt ?? utcNow(),
      ended_at: utcNow(),
      input: jsonSafe(entry.input),
      output: jsonSafe(entry.output),
      error: entry.isError ? "tool reported an error" : null,
      cost: null,
      metadata: entry.metadata ?? {},
      sealed: false,
    });
    this.seal(index);
  }

  /** Redact evidence, compute step digests, and collect redaction pointers. */
  private seal(index: number): void {
    const step = this.steps[index];
    if (!step || step.sealed) return;
    const base = `/steps/${index}`;
    const input = redact(step.input);
    const output = redact(step.output);
    const cost = redact(step.cost);
    const metadata = redact(step.metadata);
    step.input = input.value;
    step.output = output.value;
    step.cost = cost.value;
    step.metadata = metadata.value as JsonObject;
    step.ended_at = step.ended_at ?? utcNow();
    step.sealed = true;
    this.redactions.push(
      ...qualifyRedactions(input.redactions, `${base}/input`),
      ...qualifyRedactions(output.redactions, `${base}/output`),
      ...qualifyRedactions(cost.redactions, `${base}/cost`),
      ...qualifyRedactions(metadata.redactions, `${base}/metadata`),
    );
  }

  finalize(outDir: string): { bundle: JsonObject; path: string } {
    for (let index = 0; index < this.steps.length; index += 1) {
      const step = this.steps[index] as StepDraft;
      if (!step.sealed) {
        step.status = "skipped";
        step.error =
          "response not captured (aborted turn or auxiliary request such as compaction)";
        this.seal(index);
      }
    }
    const runId = randomUUID();
    const createdAt = utcNow();
    const bundle: JsonObject = {
      schema_version: "0.1",
      run_id: runId,
      created_at: createdAt,
      actor: this.actor,
      project: this.project,
      invocation: this.invocation,
      steps: this.steps.map((step, index) => ({
        step_id: `step-${index + 1}`,
        kind: step.kind,
        name: step.name,
        status: step.status,
        started_at: step.started_at,
        ended_at: step.ended_at as string,
        input: step.input,
        output: step.output,
        error: step.error,
        cost: step.cost,
        metadata: step.metadata,
        input_digest: step.input === null ? null : sha256Json(step.input),
        output_digest: step.output === null ? null : sha256Json(step.output),
      })),
      redactions: sortedUnique(this.redactions),
      metadata: this.metadata,
    };
    bundle.bundle_digest = stableDigest(bundle);

    const stamp = createdAt.slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const target = path.join(outDir, `pi-run-${stamp}-${runId.slice(0, 8)}.json`);
    mkdirSync(outDir, { recursive: true });
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    renameSync(temporary, target);
    return { bundle, path: target };
  }
}

// ---------------------------------------------------------------------------
// Pi extension wiring
// ---------------------------------------------------------------------------

interface PiUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

interface PiModel {
  provider?: string;
  id?: string;
}

interface PiSessionManager {
  getSessionId?(): string | undefined;
  getSessionFile?(): string | undefined | null;
}

interface PiContext {
  ui: PiUi;
  cwd: string;
  model?: PiModel;
  sessionManager?: PiSessionManager;
}

interface PiCommand {
  description: string;
  handler(args: string | undefined, ctx: PiContext): unknown;
}

interface PiApi {
  on(event: string, handler: (event: any, ctx: PiContext) => unknown): void;
  registerCommand(name: string, command: PiCommand): void;
}

function outputDir(cwd: string): string {
  const configured = process.env.PROOFLINE_DIR;
  return configured ? path.resolve(cwd, configured) : path.join(cwd, ".proofline");
}

function notify(ctx: PiContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // Non-interactive modes may not render notifications; recording still worked.
  }
}

export default function prooflineExtension(pi: PiApi): void {
  let enabled = true;
  let recorder: Recorder | null = null;
  let pendingModelIndex: number | null = null;
  let lastBundlePath: string | null = null;
  let bundlesWritten = 0;
  const pendingTools = new Map<string, { name: string; input: Json; startedAt: string }>();

  function reset(): void {
    recorder = null;
    pendingModelIndex = null;
    pendingTools.clear();
  }

  function flush(ctx: PiContext | null): void {
    if (!recorder) return;
    if (recorder.stepCount === 0) {
      reset();
      return;
    }
    const outDir = outputDir(recorder.cwd);
    const { bundle, path: bundlePath } = recorder.finalize(outDir);
    lastBundlePath = bundlePath;
    bundlesWritten += 1;
    reset();
    if (ctx) {
      const digest = String(bundle.bundle_digest).slice(0, 12);
      const relative = path.relative(ctx.cwd, bundlePath) || bundlePath;
      notify(ctx, `proofline: recorded ${relative} (digest ${digest})`);
    }
  }

  pi.on("agent_start", (_event, ctx) => {
    if (!enabled || recorder) return;
    const manager = ctx.sessionManager;
    recorder = new Recorder({
      cwd: ctx.cwd,
      metadata: {
        generator: "pi-proofline",
        session_id: manager?.getSessionId?.() ?? null,
        session_file: manager?.getSessionFile?.() ?? null,
      },
    });
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!recorder) return;
    const model = ctx.model;
    const name = `${model?.provider ?? "unknown"}/${model?.id ?? "model"}`;
    pendingModelIndex = recorder.beginModelStep(name, event.payload);
  });

  pi.on("after_provider_response", (event) => {
    if (recorder === null || pendingModelIndex === null) return;
    if (typeof event.status === "number") {
      recorder.annotate(pendingModelIndex, { http_status: event.status });
    }
  });

  pi.on("turn_end", (event) => {
    if (recorder === null || pendingModelIndex === null) return;
    if (typeof event.turnIndex === "number") {
      recorder.annotate(pendingModelIndex, { turn_index: event.turnIndex });
    }
    recorder.completeModelStep(pendingModelIndex, event.message);
    pendingModelIndex = null;
  });

  pi.on("tool_execution_start", (event) => {
    if (!recorder) return;
    pendingTools.set(String(event.toolCallId), {
      name: String(event.toolName),
      input: jsonSafe(event.args),
      startedAt: utcNow(),
    });
  });

  pi.on("tool_execution_end", (event) => {
    if (!recorder) return;
    const callId = String(event.toolCallId);
    const started = pendingTools.get(callId);
    pendingTools.delete(callId);
    recorder.addToolStep({
      name: started?.name ?? String(event.toolName),
      input: started?.input ?? null,
      output: event.result,
      isError: event.isError === true,
      startedAt: started?.startedAt,
      metadata: { tool_call_id: callId },
    });
  });

  pi.on("agent_settled", (_event, ctx) => flush(ctx));

  pi.on("session_shutdown", () => flush(null));

  pi.registerCommand("proofline", {
    description: "Show proofline recording status, or toggle with on/off",
    handler: (args, ctx) => {
      const argument = (args ?? "").trim().toLowerCase();
      if (argument === "on") {
        enabled = true;
        notify(ctx, "proofline: recording enabled (starts with the next prompt)");
        return;
      }
      if (argument === "off") {
        enabled = false;
        reset();
        notify(ctx, "proofline: recording disabled; in-flight run discarded");
        return;
      }
      const status = enabled ? "on" : "off";
      const lines = [
        `proofline: recording ${status}, output ${outputDir(ctx.cwd)}`,
        `bundles this session: ${bundlesWritten}${lastBundlePath ? `, last: ${lastBundlePath}` : ""}`,
        "verify with: uvx proofline verify <bundle>",
      ];
      notify(ctx, lines.join("\n"));
    },
  });
}
