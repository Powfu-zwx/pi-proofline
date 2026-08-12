/**
 * Emit cross-language parity fixtures into out/:
 *
 * - vectors.jsonl: one {raw, canonical} pair per line, where `raw` is the JSON
 *   text a bundle file would contain and `canonical` is this implementation's
 *   canonical form. cross_verify.py asserts Python produces the same canonical
 *   form after parsing `raw`.
 * - bundle.json: a synthetic run bundle produced by the Recorder.
 * - tampered.json: the same bundle with evidence edited after sealing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Recorder, canonicalJson, type Json, type JsonObject } from "../extensions/proofline.ts";

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(42);

function randomNumber(): number {
  const kind = random();
  if (kind < 0.25) {
    // Integers across the safe range and beyond 2^53.
    return Math.floor((random() * 2 - 1) * 2 ** (random() * 62));
  }
  const exponent = Math.floor(random() * 660) - 330;
  const value = (random() * 2 - 1) * Math.pow(10, exponent);
  return Number.isFinite(value) ? value : 0;
}

const CODE_POINT_RANGES: Array<[number, number]> = [
  [0x20, 0x7e],
  [0x00, 0x1f],
  [0xa0, 0x2ff],
  [0x4e00, 0x9fff],
  [0x1f300, 0x1f6ff],
  [0xfff0, 0xfffd],
];

function randomString(): string {
  const length = Math.floor(random() * 12);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const range = CODE_POINT_RANGES[Math.floor(random() * CODE_POINT_RANGES.length)] as [number, number];
    const code = range[0] + Math.floor(random() * (range[1] - range[0] + 1));
    out += String.fromCodePoint(code);
  }
  return out;
}

function buildVectors(): Json[] {
  const vectors: Json[] = [
    null,
    true,
    false,
    "",
    "plain",
    'quote " backslash \\ newline \n tab \t',
    "\u007f\u2028\u2029",
    { "\u{10000}": 1, "\uFFFD": 2, "10": 3, "2": 4, "": 5 },
    { "a/b": { "c~d": 1 } },
    [],
    {},
    [0, -0, 1e15, 1e16, 1e20, 1e21, 0.0001, 0.00001, 3e-5, 1e-7, 5e-324, 1.7976931348623157e308],
    [1234567890123456.5, 1 / 3, -3.14159, 6.02e23, 1.6e-19, 9007199254740991],
  ];
  for (let i = 0; i < 400; i += 1) vectors.push(randomNumber());
  for (let i = 0; i < 100; i += 1) vectors.push(randomString());
  for (let i = 0; i < 50; i += 1) {
    vectors.push({
      [randomString() || "k"]: [randomNumber(), randomString(), { nested: randomNumber() }],
    });
  }
  return vectors;
}

function buildBundle(cwd: string): JsonObject {
  const recorder = new Recorder({
    cwd,
    metadata: { generator: "pi-proofline", session_id: "vector-session", api_key: "leak-me" },
  });
  const modelIndex = recorder.beginModelStep("openai/gpt-test", {
    model: "gpt-test",
    messages: [
      { role: "system", content: "you are concise 中文 🎉" },
      { role: "user", content: "token check: Bearer abcdefghijklmnopqrstuvwxyz" },
    ],
    temperature: 3e-5,
    max_tokens: 100,
  });
  recorder.annotate(modelIndex, { http_status: 200 });
  recorder.completeModelStep(modelIndex, {
    role: "assistant",
    content: [{ type: "text", text: "done: sk-abcdefghijklmnop1234 was redacted" }],
    stopReason: "stop",
    usage: { input: 11, output: 7, cost: { total: 0.00001 } },
  });
  recorder.addToolStep({
    name: "bash",
    input: { command: "echo 1e16 && echo 0.00003" },
    output: { content: [{ type: "text", text: "1e16\n0.00003" }] },
    isError: false,
    metadata: { tool_call_id: "call-1" },
  });
  const { bundle } = recorder.finalize(path.join(cwd, ".proofline"));
  return bundle;
}

const outDir = fileURLToPath(new URL("../out/", import.meta.url));
mkdirSync(outDir, { recursive: true });

const lines = buildVectors().map((value) =>
  JSON.stringify({ raw: JSON.stringify(value), canonical: canonicalJson(value) }),
);
writeFileSync(path.join(outDir, "vectors.jsonl"), lines.join("\n") + "\n", "utf8");

const bundle = buildBundle(path.join(outDir, "scratch"));
writeFileSync(path.join(outDir, "bundle.json"), JSON.stringify(bundle, null, 2) + "\n", "utf8");

const tampered = JSON.parse(JSON.stringify(bundle)) as JsonObject;
const steps = tampered.steps as JsonObject[];
const output = (steps[0] as JsonObject).output as JsonObject;
(output.content as JsonObject[])[0]!.text = "history, rewritten";
writeFileSync(path.join(outDir, "tampered.json"), JSON.stringify(tampered, null, 2) + "\n", "utf8");

console.log(`emitted ${lines.length} vectors, bundle.json, tampered.json`);
