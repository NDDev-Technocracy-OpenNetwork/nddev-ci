import assert from "node:assert/strict";
import test from "node:test";
import { parseToml, TomlError } from "../lib/toml.mjs";

test("parseToml parses tables, quoted keys, inline tables, arrays of tables and scalars", () => {
  const doc = parseToml(`
# Registry-style TOML fixture
title = "registry"
count = 1_024
hex = 0xdead_beef
oct = 0o755
bin = 0b1010_0101
ratio = 3.14
enabled = true
disabled = false
updated = 2026-11-26T23:00:00Z
date_only = 2026-11-26
literal = 'no\\escapes\\here'
multiline_basic = """
first line \\
  joined"""
multiline_literal = '''
raw\\line
second'''

[technologies.just]
kind = "toolchain"
scope = "core"
source = "https://github.com/casey/just/releases"
lines = [
  { version = "1.59.0", role = "latest" },
  { version = "1.58.0", role = "compat" },
]

[technologies."actions/checkout"]
kind = "action"
scope = "ci"
source = "https://github.com/actions/checkout/releases"
lines = [{ version = "7.0.1", role = "latest", commit = "3d3c42e5aac5ba805825da76410c181273ba90b1" }]

[technologies.'nginx/nginx-unprivileged']
kind = "image"
lines = [{ version = "1.30.8-alpine-slim", role = "latest" }]

[[entries]]
name = "one"
nested.value = 1

[[entries]]
name = "two"
nested.value = 2
`);

  assert.equal(doc.title, "registry");
  assert.equal(doc.count, 1024);
  assert.equal(doc.hex, 0xdeadbeef);
  assert.equal(doc.oct, 0o755);
  assert.equal(doc.bin, 0b10100101);
  assert.equal(doc.ratio, 3.14);
  assert.equal(doc.enabled, true);
  assert.equal(doc.disabled, false);
  assert.equal(doc.updated, "2026-11-26T23:00:00Z");
  assert.equal(doc.date_only, "2026-11-26");
  assert.equal(doc.literal, "no\\escapes\\here");
  assert.equal(doc.multiline_basic, "first line joined");
  assert.equal(doc.multiline_literal, "raw\\line\nsecond");
  assert.equal(doc.technologies.just.kind, "toolchain");
  assert.deepEqual(doc.technologies.just.lines, [
    { version: "1.59.0", role: "latest" },
    { version: "1.58.0", role: "compat" },
  ]);
  assert.equal(doc.technologies["actions/checkout"].lines[0].commit, "3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.equal(doc.technologies["nginx/nginx-unprivileged"].lines[0].version, "1.30.8-alpine-slim");
  assert.deepEqual(doc.entries, [
    { name: "one", nested: { value: 1 } },
    { name: "two", nested: { value: 2 } },
  ]);
});

test("parseToml handles CRLF, unicode escapes and rejects malformed TOML", () => {
  const crlf = "msg = \"hello\\u0020\\U0001F680\"\r\n[a]\r\nk = 1\r\n";
  assert.deepEqual(parseToml(crlf), { msg: "hello \u{1F680}", a: { k: 1 } });

  for (const invalid of [
    "a = 1\na = 2\n",
    "[a]\nk = 1\n[a]\nm = 2\n",
    "bad = [1, 2",
    "bad = { a = 1, }\n",
    "bad = \"unterminated\n\"",
    "bad = 01\n",
    "[unclosed\n",
  ]) {
    assert.throws(() => parseToml(invalid), TomlError, invalid);
  }
});
