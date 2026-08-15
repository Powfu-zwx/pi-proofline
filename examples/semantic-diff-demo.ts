/**
 * Guided tour of semantic diff on pi-shaped bundles.
 *
 * Drives the real extension with canned pi events (no network, no pi binary),
 * then compares the bundles with the proofline CLI — the same path a user
 * takes after `pi install npm:pi-proofline`.
 *
 *   node examples/semantic-diff-demo.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { stdout } from "node:process";

import prooflineExtension from "../extensions/proofline.ts";

type JsonObject = { [key: string]: unknown };
type Handler = (event: JsonObject, ctx: FakeContext) => unknown;

interface FakeContext {
  ui: { notify(message: string, level?: string): void };
  cwd: string;
  model: { provider: string; id: string };
  sessionManager: { getSessionId(): string; getSessionFile(): string | null };
}

class FakePi {
  handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerCommand(): void {}

  emit(event: string, payload: JsonObject, ctx: FakeContext): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload, ctx);
  }
}

const COLOR = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
const paint = (text: string, code: string) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = (text: string) => paint(text, "1");
const dim = (text: string) => paint(text, "2");
const green = (text: string) => paint(text, "32");
const red = (text: string) => paint(text, "31");
const yellow = (text: string) => paint(text, "33");
const cyan = (text: string) => paint(text, "36");

const PROMPT = "list the files in this repo";
const PROMPT_HIDDEN = "list the files in this repo, including hidden";

function makeContext(cwd: string): FakeContext {
  return {
    ui: { notify() {} },
    cwd,
    model: { provider: "mock", id: "gpt-mock" },
    sessionManager: { getSessionId: () => "sess-demo", getSessionFile: () => null },
  };
}

function bundleFiles(cwd: string): string[] {
  try {
    return readdirSync(path.join(cwd, ".proofline"))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

function recordRun(
  cwd: string,
  prompt: string,
  tools: Array<{ name: string; args: JsonObject; result: string }>,
): string {
  const before = new Set(bundleFiles(cwd));
  const pi = new FakePi();
  prooflineExtension(pi as never);
  const ctx = makeContext(cwd);

  pi.emit("agent_start", {}, ctx);
  pi.emit(
    "before_provider_request",
    {
      payload: {
        model: "gpt-mock",
        messages: [{ role: "user", content: prompt }],
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
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
        usage: { input: 24, output: 6, cost: { total: 0 } },
      },
    },
    ctx,
  );
  for (const tool of tools) {
    const callId = tool.name;
    pi.emit(
      "tool_execution_start",
      { toolCallId: callId, toolName: tool.name, args: tool.args },
      ctx,
    );
    pi.emit(
      "tool_execution_end",
      {
        toolCallId: callId,
        toolName: tool.name,
        result: { content: [{ type: "text", text: tool.result }] },
        isError: false,
      },
      ctx,
    );
  }
  pi.emit("agent_settled", {}, ctx);

  const added = bundleFiles(cwd).filter((name) => !before.has(name));
  if (added.length !== 1) {
    throw new Error(`expected one new bundle, got ${added.join(", ") || "none"}`);
  }
  return path.join(cwd, ".proofline", added[0] as string);
}

const BASH = { name: "bash", args: { command: "ls" }, result: "README.md\n" };
const READ = { name: "read", args: { path: "README.md" }, result: "# pi-proofline\n" };

function runCli(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const candidates =
    command === "proofline"
      ? [
          ["proofline", args],
          ["uvx", ["proofline", ...args]],
          ["python", ["-m", "proofline", ...args]],
        ]
      : [[command, args]];
  let lastError: unknown;
  for (const [bin, argv] of candidates) {
    try {
      const stdout = execFileSync(bin as string, argv as string[], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      lastError = error;
      const err = error as {
        status?: number | null;
        stdout?: string;
        stderr?: string;
        code?: string;
      };
      if (err.code === "ENOENT") continue;
      if (typeof err.status === "number") {
        return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`failed to run ${command}`);
}

function naiveChangedCount(left: string, right: string): number {
  try {
    execFileSync("git", ["diff", "--no-index", "--", left, right], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return 0;
  } catch (error) {
    const stdout = String((error as { stdout?: string }).stdout ?? "");
    return stdout.split(/\r?\n/).filter((line) => /^[+-]/.test(line) && !/^[+-]{3} /.test(line))
      .length;
  }
}

function showDiff(left: string, right: string): void {
  const naive = naiveChangedCount(left, right);
  const result = runCli("proofline", ["diff", left, right]);
  const semantic = result.stdout.trim() || result.stderr.trim();
  console.log(`    ${bold("plain JSON diff")} sees ${red(String(naive))} changed lines`);
  if (result.status === 0) {
    console.log(`    ${bold("proofline diff")} sees: ${green("no semantic differences")}`);
    return;
  }
  console.log(`    ${bold("proofline diff")} sees:`);
  for (const line of semantic.split(/\r?\n/).filter(Boolean)) {
    console.log(`      ${yellow(line)}`);
  }
}

function scene(number: number, title: string): void {
  console.log();
  console.log(cyan("━".repeat(62)));
  console.log(cyan(` ${number}. ${title}`));
  console.log(cyan("━".repeat(62)));
}

function timeline(tools: string[]): string {
  return ["model", ...tools].map((name) => `[${name}]`).join(" → ");
}

function main(): number {
  runCli("proofline", ["--version"]);

  const cwd = mkdtempSync(path.join(tmpdir(), "pi-proofline-demo-"));
  console.log(bold("pi-proofline semantic diff — a guided tour"));
  console.log(dim("real extension, canned pi events, compared with the proofline CLI"));

  const rerunA = recordRun(cwd, PROMPT, [BASH]);
  const rerunB = recordRun(cwd, PROMPT, [BASH]);

  scene(1, "The same pi prompt, twice");
  console.log(`  ${dim(`$ pi "${PROMPT}"`)}`);
  console.log(`  ${dim(timeline(["bash"]))} — run A`);
  console.log(`  ${dim(timeline(["bash"]))} — run B (fresh run id, fresh timestamps)`);
  console.log();
  showDiff(rerunA, rerunB);
  console.log(`\n  ${dim("Identical agent work should diff to nothing. It does.")}`);

  scene(2, "The user prompt changes");
  const promptChange = recordRun(cwd, PROMPT_HIDDEN, [BASH]);
  console.log(`  ${dim(JSON.stringify(PROMPT))}`);
  console.log(`  ${dim(JSON.stringify(PROMPT_HIDDEN))}`);
  console.log();
  showDiff(rerunA, promptChange);
  console.log(`\n  ${dim("The payload pi sent to the provider is the evidence that changed.")}`);

  scene(3, "The agent takes an extra tool call");
  const extraTool = recordRun(cwd, PROMPT, [READ, BASH]);
  console.log(`  ${dim(timeline(["bash"]))} — baseline`);
  console.log(`  ${dim(timeline(["read", "bash"]))} — new run`);
  console.log();
  showDiff(rerunA, extraTool);
  console.log(`\n  ${dim("Aligned as sequences: one insertion, one line — not a shifted bash step.")}`);

  console.log();
  console.log(dim("reproduce: node examples/semantic-diff-demo.ts"));
  console.log(dim("then:      uvx proofline diff <a.json> <b.json>"));
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (message.includes("ENOENT") || /proofline/i.test(message)) {
    console.error("install the CLI first: pip install proofline   (or uvx proofline)");
  }
  process.exitCode = 1;
}
