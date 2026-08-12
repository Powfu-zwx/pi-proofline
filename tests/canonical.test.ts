import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalJson,
  canonicalNumber,
  compareCodePoints,
  jsonSafe,
  sha256Json,
  stableDigest,
  type JsonObject,
} from "../extensions/proofline.ts";

// Expected values are Python ground truth: json.dumps(json.loads(raw)) for the
// raw text JSON.stringify would put in a bundle file.
const NUMBER_CASES: Array<[number, string]> = [
  [0, "0"],
  [-0, "0"],
  [1, "1"],
  [-1, "-1"],
  [1e15, "1000000000000000"],
  [1e16, "10000000000000000"],
  [1e20, "100000000000000000000"],
  [1e21, "1e+21"],
  [9007199254740991, "9007199254740991"],
  [1.5, "1.5"],
  [0.1, "0.1"],
  [1 / 3, "0.3333333333333333"],
  [0.0001, "0.0001"],
  [0.00001, "1e-05"],
  [3e-5, "3e-05"],
  [1e-7, "1e-07"],
  [2.5e-8, "2.5e-08"],
  [1e-10, "1e-10"],
  [5e-324, "5e-324"],
  [1.7976931348623157e308, "1.7976931348623157e+308"],
  [1234567890123456.5, "1234567890123456.5"],
  [-3.14159, "-3.14159"],
  [6.02e23, "6.02e+23"],
  [1.6e-19, "1.6e-19"],
];

test("numbers serialize to Python's round-trip form", () => {
  for (const [value, expected] of NUMBER_CASES) {
    assert.equal(canonicalNumber(value), expected, `value ${value}`);
  }
});

test("non-finite numbers are rejected", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => canonicalNumber(value));
  }
});

test("object keys sort by code point, not UTF-16 unit", () => {
  // U+FFFD (65533) < U+10000 (65536), but the surrogate pair sorts first
  // under UTF-16 comparison. Python sorts by code point.
  assert.equal(compareCodePoints("\uFFFD", "\u{10000}"), -1);
  assert.equal(canonicalJson({ "\u{10000}": 1, "\uFFFD": 2 }), '{"\uFFFD":2,"\u{10000}":1}');
  assert.equal(canonicalJson({ b: 1, a: 2, "10": 3, "2": 4 }), '{"10":3,"2":4,"a":2,"b":1}');
});

test("strings escape like Python ensure_ascii=False", () => {
  assert.equal(canonicalJson("héllo 中文 🎉"), '"héllo 中文 🎉"');
  assert.equal(canonicalJson('quote " backslash \\'), '"quote \\" backslash \\\\"');
  assert.equal(canonicalJson("\u0001\b\t\n\f\r\u001f"), '"\\u0001\\b\\t\\n\\f\\r\\u001f"');
  // DEL and the JS line separators stay literal in both implementations.
  assert.equal(canonicalJson("\u007f\u2028\u2029"), '"\u007f\u2028\u2029"');
});

test("canonical form is compact and recursively sorted", () => {
  const value = { z: [1, { b: null, a: true }], a: "x" } as unknown as JsonObject;
  assert.equal(canonicalJson(value), '{"a":"x","z":[1,{"a":true,"b":null}]}');
});

test("stable digest ignores volatile fields and signatures", () => {
  const bundle: JsonObject = {
    schema_version: "0.1",
    run_id: "run-a",
    created_at: "2026-01-01T00:00:00.000Z",
    steps: [{ step_id: "step-1", started_at: "t0", ended_at: "t1", name: "x" }],
    redactions: [],
  };
  const digest = stableDigest(bundle);
  const relabeled = {
    ...bundle,
    run_id: "run-b",
    created_at: "2027-12-31T23:59:59.999Z",
    signatures: [{ algorithm: "ed25519", public_key: "pk", signature: "sig" }],
    steps: [{ step_id: "step-1", started_at: "later", ended_at: "even later", name: "x" }],
  };
  assert.equal(stableDigest(relabeled), digest);
  const edited = { ...bundle, steps: [{ step_id: "step-1", name: "y" }] };
  assert.notEqual(stableDigest(edited), digest);
});

test("sha256Json hashes UTF-8 bytes of the canonical form", () => {
  // Ground truth: proofline.model.sha256_json({"a": 1})
  assert.equal(sha256Json({ a: 1 }), "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
});

test("jsonSafe sanitizes what JSON cannot carry", () => {
  assert.equal(jsonSafe(undefined), null);
  assert.deepEqual(jsonSafe({ a: undefined, b: Number.NaN, f: () => 1 }), { b: null });
  assert.equal(jsonSafe("lone \uD800 surrogate"), "lone \uFFFD surrogate");
  assert.equal(jsonSafe("pair \u{1F389} kept"), "pair \u{1F389} kept");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const captured = jsonSafe(cyclic) as JsonObject;
  assert.ok(typeof captured.proofline_capture_error === "string");
});
