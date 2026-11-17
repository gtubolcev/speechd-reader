// Copyright (C) 2026 Grigory Tuboltsev
// SPDX-License-Identifier: MIT
// The Cyrillic letter hint of content/reader.js: node tests/test_lang_hint.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "..", "extension", "content", "reader.js"), "utf8");
const code = src.match(/const CYRILLIC_LETTERS[\s\S]*?\n}\n/)[0];
const cyrillicHint = new Function(code + "return cyrillicHint;")();

const cases = [
  ["главные новости", "ru"],
  ["мини-новости", null],
  ["Новини України", "uk"],
  ["Привіт світ", "uk"],
  ["Беларуская мова і літаратура, ўсё", "be"],
  ["Српски језик, ћирилица", "sr"],
  ["Македонски јазик ќе", "mk"],
  ["Хляб и мир — българският", null],
  ["Redis 17.11", null],
  ["Это і ї", null],
];
for (const [text, want] of cases)
  assert.strictEqual(cyrillicHint(text), want, text);
console.log("ok", cases.length);
