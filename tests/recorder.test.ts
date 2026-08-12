import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import prooflineExtension, {
  REDACTED,
  VERSION,
  sha256Json,
  stableDigest,
  type Json,
  type JsonObject,
} from "../extensions/proofline.ts";

type Handler = (event: JsonObject, ctx: FakeContext) => unknown;

interface FakeContext {
  ui: { notify(message: string, level?: string): void };
  cwd: string;
  hasUI: boolean;
  model: { provider: string; id: string };
  sessionManager: { getSessionId(): string; getSessionFile(): string | null };
}

class FakePi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, { description: string; handler: (args: string | undefined, ctx: FakeContext) => unknown }>();

  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerCommand(name: string, command: { description: string; handler: (args: string | undefined, ctx: FakeContext) => unknown }): void {
    this.commands.set(name, command);
  }

  emit(event: string, payload: JsonObject, ctx: FakeContext): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload, ctx);
  }
}

function makeContext(cwd: string, notices: string[]): FakeContext {
  return {
    ui: { notify: (message) => notices.push(message) },
    cwd,
    hasUI: true,
    model: { provider: "openai", id: "gpt-test" },
    sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => null },
  };
}

function bundleFiles(cwd: string): string[] {
  try {
    return readdirSync(path.join(cwd, ".proofline")).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

function readBundle(cwd: string): JsonObject {
  const files = bundleFiles(cwd);
  assert.equal(files.length, 1, `expected exactly one bundle, got ${files.length}`);
  const raw = readFileSync(path.join(cwd, ".proofline", files[0] as string), "utf8");
  return JSON.parse(raw) as JsonObject;
}

function runFullScenario(cwd: string, notices: string[]): void {
  const pi = new FakePi();
  prooflineExtension(pi as never);
  const ctx = makeContext(cwd, notices);

  pi.emit("agent_start", {}, ctx);
  pi.emit(
    "before_provider_request",
    {
      payload: {
        model: "gpt-test",
        api_key: "should-be-redacted",
        messages: [
          { role: "user", content: "run ls and say Bearer abcdefghijklmnopqrstuvwxyz" },
          { role: "user", content: "broken \uD800 surrogate" },
        ],
        max_tokens: 100,
      },
    },
    ctx,
  );
  pi.emit("after_provider_response", { status: 200 }, ctx);
  pi.emit(
    "turn_end",
    {
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input: 10, output: 5, cost: { total: 0.001 } },
      },
    },
    ctx,
  );
  pi.emit(
    "tool_execution_start",
    { toolCallId: "call-1", toolName: "bash", args: { command: "ls" } },
    ctx,
  );
  pi.emit(
    "tool_execution_end",
    {
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "file.txt" }] },
      isError: false,
    },
    ctx,
  );
  pi.emit("agent_settled", {}, ctx);
}

test("a full run produces a self-consistent, redacted bundle", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-proofline-"));
  const notices: string[] = [];
  runFullScenario(cwd, notices);

  const bundle = readBundle(cwd);
  assert.equal(bundle.schema_version, "0.1");
  assert.equal(stableDigest(bundle), bundle.bundle_digest);

  const steps = bundle.steps as JsonObject[];
  assert.equal(steps.length, 2);

  const model = steps[0] as JsonObject;
  assert.equal(model.kind, "model");
  assert.equal(model.name, "openai/gpt-test");
  assert.equal(model.status, "ok");
  const input = model.input as JsonObject;
  assert.equal(input.api_key, REDACTED);
  assert.equal(input.max_tokens, 100);
  const messages = input.messages as JsonObject[];
  assert.equal((messages[0] as JsonObject).content, REDACTED); // Bearer token in text
  assert.equal((messages[1] as JsonObject).content, "broken \uFFFD surrogate");
  assert.equal(model.input_digest, sha256Json(model.input as Json));
  assert.equal(model.output_digest, sha256Json(model.output as Json));
  assert.deepEqual(model.cost, { total: 0.001 });
  const modelMeta = model.metadata as JsonObject;
  assert.equal(modelMeta.http_status, 200);
  assert.equal(modelMeta.turn_index, 0);
  assert.equal(modelMeta.stop_reason, "stop");

  const tool = steps[1] as JsonObject;
  assert.equal(tool.kind, "tool");
  assert.equal(tool.name, "bash");
  assert.equal(tool.status, "ok");
  assert.deepEqual(tool.input, { command: "ls" });

  const redactions = bundle.redactions as string[];
  assert.ok(redactions.includes("/steps/0/input/api_key"));
  assert.ok(redactions.includes("/steps/0/input/messages/0/content"));
  assert.deepEqual([...redactions].sort(), redactions, "redactions are sorted");

  assert.equal((bundle.metadata as JsonObject).generator, "pi-proofline");
  assert.equal(notices.length, 1);
  assert.match(notices[0] as string, /proofline: recorded .*digest [0-9a-f]{12}/);
});

test("a request without a completed turn is preserved as skipped evidence", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-proofline-"));
  const pi = new FakePi();
  prooflineExtension(pi as never);
  const ctx = makeContext(cwd, []);

  pi.emit("agent_start", {}, ctx);
  pi.emit("before_provider_request", { payload: { model: "gpt-test" } }, ctx);
  pi.emit("agent_settled", {}, ctx);

  const bundle = readBundle(cwd);
  const steps = bundle.steps as JsonObject[];
  assert.equal(steps.length, 1);
  const step = steps[0] as JsonObject;
  assert.equal(step.status, "skipped");
  assert.match(step.error as string, /not captured/);
  assert.equal(stableDigest(bundle), bundle.bundle_digest);
});

test("an errored turn records the failure", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-proofline-"));
  const pi = new FakePi();
  prooflineExtension(pi as never);
  const ctx = makeContext(cwd, []);

  pi.emit("agent_start", {}, ctx);
  pi.emit("before_provider_request", { payload: { model: "gpt-test" } }, ctx);
  pi.emit(
    "turn_end",
    { turnIndex: 0, message: { role: "assistant", stopReason: "error", errorMessage: "rate limited" } },
    ctx,
  );
  pi.emit("agent_settled", {}, ctx);

  const step = (readBundle(cwd).steps as JsonObject[])[0] as JsonObject;
  assert.equal(step.status, "error");
  assert.equal(step.error, "rate limited");
});

test("recording can be toggled off and on", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-proofline-"));
  const pi = new FakePi();
  prooflineExtension(pi as never);
  const notices: string[] = [];
  const ctx = makeContext(cwd, notices);
  const command = pi.commands.get("proofline");
  assert.ok(command);

  command.handler("off", ctx);
  pi.emit("agent_start", {}, ctx);
  pi.emit("before_provider_request", { payload: { model: "gpt-test" } }, ctx);
  pi.emit("agent_settled", {}, ctx);
  assert.equal(bundleFiles(cwd).length, 0);

  command.handler("on", ctx);
  runFullScenario(cwd, notices);
  assert.equal(bundleFiles(cwd).length, 1);
});

test("a run with no steps writes nothing", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-proofline-"));
  const pi = new FakePi();
  prooflineExtension(pi as never);
  const ctx = makeContext(cwd, []);
  pi.emit("agent_start", {}, ctx);
  pi.emit("agent_settled", {}, ctx);
  assert.equal(bundleFiles(cwd).length, 0);
});

test("extension version matches package.json", () => {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const pkg = JSON.parse(raw) as { version: string };
  assert.equal(VERSION, pkg.version);
});
