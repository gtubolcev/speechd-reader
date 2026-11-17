/*
 * Copyright (C) 2026 Grigory Tuboltsev
 * SPDX-License-Identifier: MIT
 *
 * Finds what to read on the page, cuts it into sentences, sends them to
 * Speech Dispatcher (through the background page) and highlights them in
 * the page itself, without changing the page's DOM:
 *
 *  - the article: Readability runs on a clone of the document; the clone's
 *    elements carry the index of their live twin, so what Readability kept
 *    maps back to the live page;
 *  - the selection, "read from here", or a part chosen with the picker.
 *
 * Highlighting uses the CSS Custom Highlight API (no wrapper elements).
 */
/* global Readability */
"use strict";

(() => {
if (typeof window.__speechdReader === "object")
  return;

const SKIP = "script, style, noscript, template, textarea, select, option, button, input, " +
             "svg, canvas, video, audio, iframe, object, embed, sup, rt, rp, " +
             "[aria-hidden='true'], [hidden], .speechd-reader-ui";
const NOT_ARTICLE = "nav, aside, footer, header, menu, dialog, form, " +
                    "[role='navigation'], [role='banner'], [role='contentinfo'], " +
                    "[role='complementary'], [role='search'], [role='dialog']";
const MAX_SENTENCE = 400;     // longer runs are cut at a space
const IN_FLIGHT = 2;          // sentences queued in speechd ahead

/* ---------- the text model ---------- */

const displayCache = new WeakMap();
function isBlock(el) {
  let d = displayCache.get(el);
  if (d === undefined) {
    d = getComputedStyle(el).display;
    displayCache.set(el, d);
  }
  return !(d.startsWith("inline") || d === "contents" || d === "ruby" || d === "ruby-text");
}

function blockOf(node) {
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (el && el !== document.body && !isBlock(el))
    el = el.parentElement;
  return el || document.body;
}

function visible(el) {
  return el.checkVisibility
    ? el.checkVisibility({visibilityProperty: true, opacityProperty: true})
    : el.getClientRects().length > 0;
}

/* the language of @el: explicit lang nearest to it; null for "not said" */
function declaredLang(el) {
  const holder = el.closest("[lang]");
  if (!holder)
    return null;
  const lang = holder.getAttribute("lang").trim();
  if (!lang)
    return null;
  return {lang, own: holder !== document.documentElement};
}

/*
 * Units: runs of text nodes sharing their nearest block element, in
 * document order. @accept(textNode) filters nodes; @range clips to a range.
 */
function collectUnits(root, accept, range) {
  const units = [];
  let cur = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(n) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.matches(SKIP))
          return NodeFilter.FILTER_REJECT;
        if (n.tagName === "BR")
          return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
      if (!n.nodeValue.trim() && !/\s/.test(n.nodeValue))
        return NodeFilter.FILTER_SKIP;
      if (range && !range.intersectsNode(n))
        return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === Node.ELEMENT_NODE) {          // <br>
      if (cur)
        cur.parts.push({node: null, text: "\n"});
      continue;
    }
    const parent = n.parentElement;
    if (!parent || !visible(parent) || (accept && !accept(n)))
      continue;
    let start = 0, end = n.nodeValue.length;
    if (range) {
      if (n === range.startContainer) start = range.startOffset;
      if (n === range.endContainer) end = range.endOffset;
    }
    const block = blockOf(n);
    if (!cur || cur.block !== block) {
      if (cur && !cur.parts.every((p) => !p.text.trim()))
        units.push(cur);
      cur = {block, parts: []};
    }
    cur.parts.push({node: n, start, text: n.nodeValue.slice(start, end)});
  }
  if (cur && !cur.parts.every((p) => !p.text.trim()))
    units.push(cur);
  return units;
}

/* text of a unit plus a map from its offsets back to DOM positions */
function unitText(unit) {
  let text = "";
  const map = [];
  for (const p of unit.parts) {
    map.push({offset: text.length, part: p});
    text += p.text;
  }
  return {text, map};
}

function domPoint(map, offset) {
  let i = map.length - 1;
  while (i > 0 && map[i].offset > offset)
    i--;
  // skip <br> parts, which have no node
  while (i < map.length - 1 && !map[i].part.node)
    i++;
  const {part} = map[i];
  const local = Math.min(Math.max(offset - map[i].offset, 0), part.text.length);
  return {node: part.node, offset: part.start + local};
}

function rangeOf(map, start, end) {
  const r = document.createRange();
  const a = domPoint(map, start), b = domPoint(map, end);
  if (!a.node || !b.node)
    return null;
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  return r;
}

function cutLong(text, start, end, out) {
  while (end - start > MAX_SENTENCE) {
    let cut = text.lastIndexOf(" ", start + MAX_SENTENCE);
    if (cut <= start)
      cut = start + MAX_SENTENCE;
    out.push([start, cut]);
    start = cut;
  }
  out.push([start, end]);
}

/* sentences of a unit: [{text, range, lang}] */
function sentencesOf(unit, lang) {
  const {text, map} = unitText(unit);
  const spans = [];
  let seg;
  try {
    seg = new Intl.Segmenter(lang || undefined, {granularity: "sentence"});
  } catch (e) {
    seg = new Intl.Segmenter(undefined, {granularity: "sentence"});
  }
  for (const s of seg.segment(text)) {
    // citation marks like "[12]" are not sentences of their own
    // nor are breaks after initials and short abbreviations ("A. Writer", "Dr. No", "т. е.")
    const prev = spans.length ? text.slice(spans[spans.length - 1][0], s.index) : "";
    if (spans.length && (/^\s*\[\d+\]\s*$/.test(s.segment) ||
        /(^|[\s(])(\p{Lu}|\p{L}{1,3}\.\p{L}{1,2}|Mr|Mrs|Ms|Dr|Prof|St|vs|etc|e\.g|i\.e|т|г|гг|ул|им|см|др|пр|н|э)\.\s*$/u.test(prev))) {
      spans[spans.length - 1][1] = s.index + s.segment.length;
      continue;
    }
    cutLong(text, s.index, s.index + s.segment.length, spans);
  }
  const out = [];
  for (let [a, b] of spans) {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    const t = text.slice(a, b).replace(/\s+/g, " ");
    if (!/[\p{L}\p{N}]/u.test(t))
      continue;
    const range = rangeOf(map, a, b);
    if (range)
      out.push({text: t, range, lang});
  }
  return out;
}

/* ---------- languages ---------- */

let langOverride = null;          // set from the popup for this page
let siteCorrections = {};          // detected -> corrected, per site

async function detect(text) {
  if (!browser.i18n.detectLanguage || text.length < 30)
    return null;
  try {
    const r = await browser.i18n.detectLanguage(text.slice(0, 2000));
    const best = r.languages.find((l) => l.language !== "und");
    return r.isReliable && best ? best.language : null;
  } catch (e) {
    return null;
  }
}

/*
 * An explicit lang on the block or its section wins; the page's own <html
 * lang> is often just the site's template, so a reliable detection that
 * disagrees with it wins over it.
 */
async function langOf(unit, text) {
  if (langOverride)
    return langOverride;
  const d = declaredLang(unit.block);
  if (d && d.own)
    return d.lang;
  const found = await detect(text);
  if (found) {
    const fixed = siteCorrections[found] || found;
    if (!d || !d.lang.toLowerCase().startsWith(fixed.split("-")[0].toLowerCase()))
      return fixed;
  }
  return d ? d.lang : (document.documentElement.lang || navigator.language);
}

/* ---------- what to read ---------- */

function articleUnits() {
  const live = [];
  const index = new WeakMap();
  const clone = document.cloneNode(true);
  // walk both trees in step: the clone has the same shape
  const a = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
  const b = document.createTreeWalker(clone.documentElement, NodeFilter.SHOW_ELEMENT);
  let x = a.currentNode, y = b.currentNode;
  while (x && y) {
    if (x.tagName !== y.tagName)
      break;                                  // the page changed under us
    index.set(x, live.length);
    y.setAttribute("data-sdr", live.length);
    live.push(x);
    x = a.nextNode();
    y = b.nextNode();
  }
  let article = null;
  for (const opts of [{nbTopCandidates: 10, charThreshold: 800}, {}]) {
    try {
      article = new Readability(clone.cloneNode(true),
                                Object.assign({serializer: (el) => el}, opts)).parse();
    } catch (e) {
      article = null;
    }
    if (article && article.length > 200)
      break;
  }
  if (!article || !article.content)
    return null;
  const kept = new Set();
  for (const el of article.content.querySelectorAll("[data-sdr]"))
    kept.add(Number(el.getAttribute("data-sdr")));
  if (!kept.size)
    return null;
  const units = collectUnits(document.body, (t) => kept.has(index.get(t.parentElement)));
  // Readability keeps the title out of the content: read it first
  const h1 = units.length && firstHeading(units[0].block);
  if (h1)
    units.unshift(...collectUnits(h1));
  return units.length ? units : null;
}

/* the title heading just before the article's first block, if any */
function firstHeading(block) {
  const all = [...document.querySelectorAll("h1")].filter(visible);
  for (const h of all.reverse()) {
    if (h.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING &&
        !h.contains(block) && !block.contains(h))
      return h;
  }
  return null;
}

/* without an article: the visible text outside navigation and asides */
function pageUnits(root = document.body) {
  return collectUnits(root, (t) => !t.parentElement.closest(NOT_ARTICLE));
}

function selectionUnits() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim())
    return null;
  const units = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    units.push(...collectUnits(r.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement, null, r));
  }
  return units.length ? units : null;
}

/* from @el on: the rest of the article if @el is in it, else of the page */
function unitsFrom(el) {
  const list = articleUnits() || pageUnits();
  let i = list.findIndex((u) => u.block === el || el.contains(u.block) || u.block.contains(el));
  if (i < 0)
    i = list.findIndex((u) => el.compareDocumentPosition(u.block) & Node.DOCUMENT_POSITION_FOLLOWING);
  if (i < 0) {
    const own = pageUnits(document.body);
    i = own.findIndex((u) => u.block === el || el.contains(u.block) || u.block.contains(el) ||
                             el.compareDocumentPosition(u.block) & Node.DOCUMENT_POSITION_FOLLOWING);
    return i < 0 ? null : own.slice(i);
  }
  return list.slice(i);
}

/* ---------- the reader ---------- */

const hlSentence = new Highlight();
const hlBlock = new Highlight();
CSS.highlights.set("speechd-reader-sentence", hlSentence);
CSS.highlights.set("speechd-reader-block", hlBlock);

const reader = {
  units: [], unit: 0,           // what is being read
  queue: [],                    // sentences of units already split
  sent: [],                     // sentences in speechd: {id, s}
  nextId: 1,
  generation: 0,
  paused: false,
  active: false,
};

function clearHighlight() {
  hlSentence.clear();
  hlBlock.clear();
}

function stop(tell = true) {
  reader.generation++;
  reader.active = false;
  reader.paused = false;
  reader.units = [];
  reader.queue = [];
  reader.sent = [];
  clearHighlight();
  if (tell)
    browser.runtime.sendMessage({type: "stop"}).catch(() => {});
}

async function start(units) {
  stop();
  if (!units || !units.length)
    return {error: "Nothing to read here"};
  reader.units = units;
  reader.unit = 0;
  reader.active = true;
  await fill(reader.generation);
  return {ok: true, units: units.length};
}

/* keep IN_FLIGHT sentences in speechd */
async function fill(gen) {
  while (gen === reader.generation && reader.sent.length < IN_FLIGHT) {
    if (!reader.queue.length) {
      if (reader.unit >= reader.units.length)
        break;
      const unit = reader.units[reader.unit++];
      const text = unitText(unit).text;
      const lang = await langOf(unit, text);
      if (gen !== reader.generation)
        return;
      reader.queue.push(...sentencesOf(unit, lang).map((s) => Object.assign(s, {unit})));
      continue;
    }
    const s = reader.queue.shift();
    const id = reader.nextId++;
    reader.sent.push({id, s});
    browser.runtime.sendMessage({type: "speak", id, text: s.text, lang: s.lang}).catch(() => {});
  }
  if (gen === reader.generation && !reader.sent.length && !reader.queue.length &&
      reader.unit >= reader.units.length)
    stop(false);
}

function show(s) {
  hlSentence.clear();
  hlSentence.add(s.range);
  hlBlock.clear();
  const block = document.createRange();
  block.selectNodeContents(s.unit.block);
  hlBlock.add(block);
  const rect = s.range.getBoundingClientRect();
  if (rect.height && (rect.top < 0 || rect.bottom > window.innerHeight))
    s.unit.block.scrollIntoView({block: "center", behavior: "smooth"});
}

function onEvent(msg) {
  const i = reader.sent.findIndex((x) => x.id === msg.id);
  if (i < 0)
    return;
  const {s} = reader.sent[i];
  if (msg.event === "begin") {
    show(s);
    return;
  }
  if (msg.event === "error") {
    stop(false);
    notice(msg.message || "Speech failed");
    return;
  }
  if (msg.event === "cancel") {
    // speechd dropped it (a screen reader spoke, another client): go on
  }
  reader.sent.splice(i, 1);
  fill(reader.generation);
}

/* ---------- a small notice in the page ---------- */

function notice(text) {
  const el = document.createElement("div");
  el.className = "speechd-reader-ui speechd-reader-notice";
  el.setAttribute("role", "alert");
  el.textContent = text;
  document.documentElement.append(el);
  setTimeout(() => el.remove(), 5000);
}

/* ---------- the element picker: an alternative to Readability ---------- */

const picker = {
  on: false, box: null, label: null, el: null, trail: [],
};

function pickerShow(el) {
  picker.el = el;
  const r = el.getBoundingClientRect();
  Object.assign(picker.box.style, {
    left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px",
  });
  const words = (el.innerText || "").trim().split(/\s+/).filter(Boolean).length;
  picker.label.textContent = el.tagName.toLowerCase() +
    (el.id ? "#" + el.id : "") + " · " + words + " words";
  picker.label.style.left = Math.max(r.left, 0) + "px";
  picker.label.style.top = (r.top > 24 ? r.top - 22 : Math.min(r.bottom + 2, window.innerHeight - 22)) + "px";
}

function pickerTarget(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!el.closest(".speechd-reader-ui") && el !== document.documentElement)
      return el === document.body ? null : el;
  }
  return null;
}

function onPickMove(e) {
  const el = pickerTarget(e.clientX, e.clientY);
  if (el && el !== picker.el) {
    picker.trail = [];
    pickerShow(el);
  }
}

function pickerUp() {
  const p = picker.el && picker.el.parentElement;
  if (p && p !== document.body && p !== document.documentElement) {
    picker.trail.push(picker.el);
    pickerShow(p);
  }
}

function pickerDown() {
  if (picker.trail.length)
    pickerShow(picker.trail.pop());
  else if (picker.el && picker.el.firstElementChild)
    pickerShow(picker.el.firstElementChild);
}

function onPickWheel(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.deltaY < 0) pickerUp(); else pickerDown();
}

function onPickKey(e) {
  const keys = {
    Escape: () => pickerEnd(),
    ArrowUp: pickerUp,
    ArrowDown: pickerDown,
    ArrowLeft: () => picker.el && picker.el.previousElementSibling && pickerShow(picker.el.previousElementSibling),
    ArrowRight: () => picker.el && picker.el.nextElementSibling && pickerShow(picker.el.nextElementSibling),
    Enter: () => pickerChoose(e.shiftKey),
  };
  if (!keys[e.key])
    return;
  e.preventDefault();
  e.stopPropagation();
  keys[e.key]();
}

function onPickClick(e) {
  e.preventDefault();
  e.stopPropagation();
  const el = pickerTarget(e.clientX, e.clientY);
  if (el && el !== picker.el && !picker.trail.length)
    pickerShow(el);
  pickerChoose(e.shiftKey);
}

function swallow(e) {
  e.preventDefault();
  e.stopPropagation();
}

function pickerChoose(fromHere) {
  const el = picker.el;
  pickerEnd();
  if (!el)
    return;
  start(fromHere ? unitsFrom(el) : collectUnits(el));
}

const PICK_EVENTS = [
  ["mousemove", onPickMove], ["wheel", onPickWheel], ["keydown", onPickKey],
  ["click", onPickClick], ["mousedown", swallow], ["mouseup", swallow], ["auxclick", swallow],
];

function pickerStart() {
  if (picker.on)
    return;
  stop();
  picker.on = true;
  picker.box = document.createElement("div");
  picker.box.className = "speechd-reader-ui speechd-reader-pick";
  picker.label = document.createElement("div");
  picker.label.className = "speechd-reader-ui speechd-reader-pick-label";
  const help = document.createElement("div");
  help.className = "speechd-reader-ui speechd-reader-notice";
  help.textContent = "Click: read this part · Shift+click: read from here · " +
                     "Wheel or ↑↓: larger/smaller · ←→: neighbours · Esc: cancel";
  picker.help = help;
  document.documentElement.append(picker.box, picker.label, help);
  for (const [t, f] of PICK_EVENTS)
    window.addEventListener(t, f, {capture: true, passive: false});
  // start with the article Readability found, so the keyboard alone works
  const units = articleUnits();
  const first = units && units.find((u) => u.block !== document.body);
  pickerShow(first ? first.block : document.body.firstElementChild || document.body);
}

function pickerEnd() {
  if (!picker.on)
    return;
  picker.on = false;
  for (const [t, f] of PICK_EVENTS)
    window.removeEventListener(t, f, {capture: true});
  picker.box.remove();
  picker.label.remove();
  picker.help.remove();
  picker.el = null;
  picker.trail = [];
}

/* ---------- messages ---------- */

async function act(msg) {
  switch (msg.action) {
  case "auto":
    return start(selectionUnits() || articleUnits() || pageUnits());
  case "article":
    return start(articleUnits() || pageUnits());
  case "selection":
    return start(selectionUnits());
  case "from-here": {
    let el = null;
    if (msg.targetElementId != null && browser.menus && browser.menus.getTargetElement)
      el = browser.menus.getTargetElement(msg.targetElementId);
    return start(el ? unitsFrom(el) : null);
  }
  case "page":
    return start(pageUnits());
  case "pick-element":
    pickerStart();
    return {ok: true};
  case "stop":
    stop();
    return {ok: true};
  case "toggle-pause":
    if (!reader.active)
      return {ok: false};
    reader.paused = !reader.paused;
    browser.runtime.sendMessage({type: reader.paused ? "pause" : "resume"}).catch(() => {});
    return {ok: true, paused: reader.paused};
  case "set-lang":
    langOverride = msg.lang || null;
    return {ok: true};
  case "state":
    return {active: reader.active, paused: reader.paused, picking: picker.on,
            lang: langOverride,
            pageLang: document.documentElement.lang || null};
  }
  return {error: "unknown action"};
}

browser.runtime.onMessage.addListener((msg) => {
  if (!msg)
    return;
  if (msg.type === "action")
    return act(msg);
  if (msg.type === "event")
    return onEvent(msg);
  if (msg.type === "stopped")
    stop(false);
});

window.__speechdReader = {act, collectUnits, articleUnits, pageUnits, sentencesOf, unitText};
})();
