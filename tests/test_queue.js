// Copyright (C) 2026 Grigory Tuboltsev
// SPDX-License-Identifier: MIT
// The reading queue of content/reader.js (fill, takeGroup, the events,
// requeueLost) with the page and the browser stubbed: node tests/test_queue.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "..", "extension", "content", "reader.js"), "utf8");
const lines = src.split("\n");
// the source from the line that starts with `from` up to (not including)
// the line that starts with `to`
function slice(from, to) {
  const a = lines.findIndex((l) => l.startsWith(from));
  const b = lines.findIndex((l, i) => i > a && l.startsWith(to));
  assert(a >= 0 && b > a, from);
  return lines.slice(a, b).join("\n") + "\n";
}
const code =
  lines.filter((l) => /^const (IN_FLIGHT|GROUP_SENTENCES|GROUP_CHARS) /.test(l)).join("\n") +
  "\n" + slice("const reader = {", "/* ---------- a small notice");

function make() {
  const sent = [], notices = [];
  const browser = {
    runtime: {sendMessage: (m) => { sent.push(m); return Promise.resolve(); }},
    i18n: {getMessage: (k) => k},
  };
  // a unit is a list of sentences; its text is what they say
  const stubs = {
    browser,
    hlSentence: {clear() {}, add() {}}, hlBlock: {clear() {}, add() {}},
    panelUpdate() {}, show() {}, notice: (t) => notices.push(t),
    document: {createRange: () => ({selectNodeContents() {}})},
    window: {innerHeight: 1000},
    detect: async () => "en", siteCorrections: {},
    unitText: (u) => ({text: u.join(" ")}),
    langOf: async () => "en",
    sentencesOf: (u, lang) => u.map((text) => ({text, lang, range: {getBoundingClientRect: () => ({})}})),
  };
  const names = Object.keys(stubs);
  const api = new Function(...names, code +
    "return {reader, start, stop, fill, onEvent, requeueLost};")(...names.map((n) => stubs[n]));
  return Object.assign(api, {sent, notices});
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const speaks = (t) => t.sent.filter((m) => m.type === "speak");

async function main() {
  // two paragraphs in flight, the third after an end
  {
    const t = make();
    await t.start([["A1.", "A2."], ["B1."], ["C1."]]);
    assert.deepStrictEqual(speaks(t).map((m) => m.parts), [["A1.", "A2."], ["B1."]]);
    t.onEvent({event: "end", id: 1});
    await tick();
    assert.deepStrictEqual(speaks(t).map((m) => m.parts)[2], ["C1."]);
    t.onEvent({event: "end", id: 2});
    t.onEvent({event: "end", id: 3});
    await tick();
    assert(t.sent.some((m) => m.type === "done") && !t.reader.active);
  }
  // a cancel from another client: the paragraph again from the sentence
  // that was sounding, before the one that was queued behind it
  {
    const t = make();
    await t.start([["A1.", "A2.", "A3."], ["B1."], ["C1."]]);
    t.onEvent({event: "mark", id: 1, part: 1});
    t.onEvent({event: "cancel", id: 1});
    t.onEvent({event: "cancel", id: 2});
    await tick(80);
    assert.deepStrictEqual(speaks(t).map((m) => m.parts).slice(2), [["A2.", "A3."], ["B1."]]);
    assert(t.reader.active && !t.notices.length);
  }
  // our own stop: the cancels that follow change nothing
  {
    const t = make();
    await t.start([["A1."], ["B1."], ["C1."]]);
    t.stop();
    t.onEvent({event: "cancel", id: 1});
    await tick(80);
    assert.strictEqual(speaks(t).length, 2);
  }
  // lost three times: given up with a notice; cancels are allowed more
  {
    const t = make();
    await t.start([["A1."], ["B1."]]);
    for (let i = 0; i < 4 && t.reader.active; i++) {
      for (const x of [...t.reader.sent])
        t.onEvent({event: "lost", id: x.id});
      await tick(80);
    }
    assert(!t.reader.active && t.notices.length === 1, t.notices);
    const u = make();
    await u.start([["A1."], ["B1."]]);
    for (let i = 0; i < 10; i++) {
      for (const x of [...u.reader.sent])
        u.onEvent({event: "cancel", id: x.id});
      await tick(80);
    }
    assert(u.reader.active && !u.notices.length);
  }
  // grouping: at most GROUP_SENTENCES of one paragraph
  {
    const t = make();
    await t.start([Array.from({length: 10}, (_, i) => "S" + i + ".")]);
    assert.deepStrictEqual(speaks(t).map((m) => m.parts.length), [8, 2]);
  }
  console.log("ok queue");
}

main().catch((e) => { console.error(e); process.exit(1); });
