import assert from "node:assert/strict";
import { test } from "node:test";

import { REDACTED, redact } from "../extensions/proofline.ts";

test("secret-looking keys are redacted with pointers", () => {
  const { value, redactions } = redact({
    api_key: "abc",
    Authorization: "whatever",
    "private-key": "pem",
    nested: { auth: "x", token: "y" },
    max_tokens: 100,
    total_tokens: 5,
  });
  assert.deepEqual(value, {
    api_key: REDACTED,
    Authorization: REDACTED,
    "private-key": REDACTED,
    nested: { auth: REDACTED, token: REDACTED },
    max_tokens: 100,
    total_tokens: 5,
  });
  assert.deepEqual(redactions.sort(), [
    "/Authorization",
    "/api_key",
    "/nested/auth",
    "/nested/token",
    "/private-key",
  ]);
});

test("null-valued secret keys are left alone", () => {
  const { value, redactions } = redact({ api_key: null });
  assert.deepEqual(value, { api_key: null });
  assert.deepEqual(redactions, []);
});

test("secret-looking values are redacted wherever they appear", () => {
  const secrets = [
    "sk-abcdefghijklmnop1234",
    "ghp_abcdefghijklmnopqrst",
    "github_pat_abcdefghijklmnopqrstuv",
    "AKIAABCDEFGHIJKLMNOP",
    "xoxb-1234567890-abc",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdef",
    "Bearer abcdefghijklmnopqrstuvwxyz",
    "-----BEGIN RSA PRIVATE KEY-----",
  ];
  for (const secret of secrets) {
    const { value, redactions } = redact([`prefix ${secret} suffix`]);
    assert.deepEqual(value, [REDACTED], secret);
    assert.deepEqual(redactions, ["/0"], secret);
  }
});

test("plain strings survive", () => {
  const { value, redactions } = redact({ text: "regular content, no secrets" });
  assert.deepEqual(value, { text: "regular content, no secrets" });
  assert.deepEqual(redactions, []);
});

test("pointer segments escape ~ and /", () => {
  const { redactions } = redact({ "a/b": { "c~d": { token: "x" } } });
  assert.deepEqual(redactions, ["/a~1b/c~0d/token"]);
});

test("a bare secret string reports the root pointer", () => {
  const { value, redactions } = redact("sk-abcdefghijklmnop1234");
  assert.equal(value, REDACTED);
  assert.deepEqual(redactions, ["/"]);
});
