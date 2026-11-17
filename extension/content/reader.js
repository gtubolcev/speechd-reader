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

/*
 * The box a text node sits in inside its block: a list item, an
 * inline-block, or an item of a flex/grid row. Menus put their items next to
 * each other with no space in the source ("<li>A</li><li>B</li>"); the screen
 * shows a gap, the text has none ("AB"). Returns [box, item]: item is true
 * for list and flex/grid items, which read as separate phrases.
 */
function boxOf(node, block) {
  let el = node.parentElement;
  while (el && el !== block) {
    if (el.tagName === "LI" || el.tagName === "TD" || el.tagName === "TH")
      return [el, true];
    const d = getComputedStyle(el).display;
    const parent = el.parentElement;
    const pd = parent ? getComputedStyle(parent).display : "";
    if (/(^|-)(flex|grid)$/.test(pd))
      return [el, true];
    if (/^inline-(block|flex|grid|table)$/.test(d))
      return [el, false];
    el = parent;
  }
  return [null, false];
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
      cur = {block, parts: [], box: null};
    }
    const text = n.nodeValue.slice(start, end);
    const [box, item] = boxOf(n, block);
    if (cur.parts.length && box !== cur.box) {
      // items of a menu or a row are phrases of their own; other boxes
      // only need a space between them
      const left = cur.parts[cur.parts.length - 1].text;
      if (item || cur.item)
        cur.parts.push({node: null, text: "\n"});
      else if (!/\s$/.test(left) && !/^\s/.test(text))
        cur.parts.push({node: null, text: " "});
    }
    cur.box = box;
    cur.item = item;
    cur.parts.push({node: n, start, text});
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
    // a line break in the source is a space on the screen, but a sentence
    // end for Intl.Segmenter; same length, so the offsets stay right
    const keep = p.node && /^(pre|pre-wrap|pre-line|break-spaces)$/.test(
      getComputedStyle(p.node.parentElement).whiteSpace);
    text += p.node && !keep ? p.text.replace(/[\r\n]/g, " ") : p.text;
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
  } else if (reader.lastLang) {
    // too short or unclear to tell (">> ещё 3 мини-новости"): the language
    // of the text read just before, not the browser's
    return reader.lastLang;
  }
  return d ? d.lang : (document.documentElement.lang || navigator.language);
}

/* ---------- what to read ---------- */

function articleUnits() {
  const live = [];
  const index = new WeakMap();
  const clone = document.cloneNode(true);
  // walk both trees in step: the clone has the same shape. Each element
  // gets a mark of its own name: Readability drops wrappers by copying
  // their attributes onto the child, and one shared name would lose the
  // child's mark (bsky.app: the post text, under a wrapper div)
  const a = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
  const b = document.createTreeWalker(clone.documentElement, NodeFilter.SHOW_ELEMENT);
  let x = a.currentNode, y = b.currentNode;
  while (x && y) {
    if (x.tagName !== y.tagName)
      break;                                  // the page changed under us
    index.set(x, live.length);
    y.setAttribute("data-sdr-" + live.length, "");
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
  for (const el of [article.content, ...article.content.querySelectorAll("*")])
    for (const name of el.getAttributeNames())
      if (name.startsWith("data-sdr-"))
        kept.add(Number(name.slice(9)));
  if (!kept.size)
    return null;
  // Readability also moves text into new elements without marks (a div of
  // text and links becomes a <p>: bsky.app posts). Text nodes are moved,
  // not changed: take a text it kept if an ancestor is in the article.
  const texts = new Map();
  const w = document.createTreeWalker(article.content, NodeFilter.SHOW_TEXT);
  for (let t; (t = w.nextNode());)
    texts.set(t.nodeValue, (texts.get(t.nodeValue) || 0) + 1);
  const inArticle = (el) => {
    for (; el; el = el.parentElement)
      if (kept.has(index.get(el)))
        return true;
    return false;
  };
  const units = collectUnits(document.body, (t) => {
    const n = texts.get(t.nodeValue) || 0;
    const parentKept = kept.has(index.get(t.parentElement));
    if (!parentKept && !(n && inArticle(t.parentElement)))
      return false;
    if (n)
      texts.set(t.nodeValue, n - 1);
    return true;
  });
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

/* without an article: the visible text outside navigation and asides;
 * @all: everything, also menus, header and footer ("Read the whole page") */
function pageUnits(root = document.body, all = false) {
  return collectUnits(root, all ? null : (t) => !t.parentElement.closest(NOT_ARTICLE));
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
    const own = pageUnits(document.body, true);
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
  lastLang: null,               // of the unit read last: for short ones
  generation: 0,
  requeue: 0,                   // timer: put lost sentences back
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
  reader.lastLang = null;
  clearHighlight();
  panelUpdate();
  if (tell)
    browser.runtime.sendMessage({type: "stop"}).catch(() => {});
}

async function start(units) {
  stop();
  if (!units || !units.length)
    return {error: browser.i18n.getMessage("nothingToRead")};
  reader.units = units;
  reader.unit = 0;
  reader.active = true;
  panelUpdate();
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
      reader.lastLang = lang;
      reader.queue.push(...sentencesOf(unit, lang).map((s) => Object.assign(s, {unit})));
      continue;
    }
    const s = reader.queue.shift();
    const id = reader.nextId++;
    reader.sent.push({id, s});
    browser.runtime.sendMessage({type: "speak", id, text: s.text, lang: s.lang}).catch(() => {});
  }
  if (gen === reader.generation && !reader.sent.length && !reader.queue.length &&
      reader.unit >= reader.units.length) {
    stop(false);
    browser.runtime.sendMessage({type: "done"}).catch(() => {});
  }
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
    browser.runtime.sendMessage({type: "done"}).catch(() => {});
    notice(msg.message || browser.i18n.getMessage("speechFailed"));
    return;
  }
  if (msg.event === "lost") {
    // the server went away (a crash on a settings reload): speak these
    // again, in their order, once all the lost ones have come in
    reader.sent[i].lost = true;
    if (!reader.requeue)
      reader.requeue = setTimeout(requeueLost, 50, reader.generation);
    return;
  }
  if (msg.event === "cancel") {
    // speechd dropped it (a screen reader spoke, another client): go on
  }
  reader.sent.splice(i, 1);
  fill(reader.generation);
}

const MAX_RETRIES = 3;

function requeueLost(gen) {
  reader.requeue = 0;
  if (gen !== reader.generation)
    return;
  const lost = reader.sent.filter((x) => x.lost).map((x) => x.s);
  reader.sent = reader.sent.filter((x) => !x.lost);
  if (lost.some((s) => (s.tries = (s.tries || 0) + 1) > MAX_RETRIES)) {
    stop();
    notice(browser.i18n.getMessage("speechFailed"));
    return;
  }
  reader.queue.unshift(...lost);
  fill(gen);
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
  if (onPanel(e))
    return;
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

/* the panel works while picking: its 🎯 again, ⏹, ✕ */
const onPanel = (e) => e.target instanceof Element && e.target.closest(".speechd-reader-panel");

function onPickClick(e) {
  if (onPanel(e))
    return;
  e.preventDefault();
  e.stopPropagation();
  const el = pickerTarget(e.clientX, e.clientY);
  if (el && el !== picker.el && !picker.trail.length)
    pickerShow(el);
  pickerChoose(e.shiftKey);
}

function swallow(e) {
  if (onPanel(e))
    return;
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
  help.textContent = browser.i18n.getMessage("pickHelp");
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

/* ---------- a "read from here" button next to the paragraph under the mouse ---------- */

const hover = {on: false, button: null, blocks: null, block: null, timer: 0};

function hoverBlocks() {
  if (!hover.blocks) {
    const units = articleUnits() || pageUnits();
    hover.blocks = new Set(units.map((u) => u.block));
  }
  return hover.blocks;
}

function hoverPlace(block) {
  hover.block = block;
  if (!block) {
    hover.button.hidden = true;
    return;
  }
  const r = block.getBoundingClientRect();
  const size = 24;
  // at the start of the first line: in the left margin, else in the space
  // the indent and the margin leave, and only on a page that has neither,
  // half-transparent over the first letter
  const text = document.createRange();
  text.selectNodeContents(block);
  const first = [...text.getClientRects()].find((l) => l.width > 0) || r;
  let left = r.left - size - 4;
  if (left < 2)
    left = Math.max(first.left - size - 4, 2);
  const top = first.top + (first.height - size) / 2;
  hover.button.style.left = left + "px";
  hover.button.style.top = Math.max(top, 0) + "px";
  hover.button.hidden = false;
}

/* the pointer is on the way from the paragraph to its button */
function nearButton(x, y) {
  if (!hover.block || hover.button.hidden)
    return false;
  const b = hover.button.getBoundingClientRect();
  const r = hover.block.getBoundingClientRect();
  const left = Math.min(b.left, r.left) - 8, right = Math.max(b.right, r.right) + 8;
  const top = Math.min(b.top, r.top) - 8, bottom = Math.max(b.bottom, r.bottom) + 8;
  return x >= left && x <= right && y >= top && y <= bottom;
}

function onHoverMove(e) {
  if (picker.on)
    return;
  clearTimeout(hover.timer);
  if (e.target === hover.button)
    return;
  const near = nearButton(e.clientX, e.clientY);
  hover.timer = setTimeout(() => {
    const blocks = hoverBlocks();
    let el = document.elementFromPoint(e.clientX, e.clientY);
    while (el && !blocks.has(el))
      el = el.parentElement;
    if (near) {
      // between the paragraph and its button: keep it, and give the pointer
      // time to get there over gaps and neighbours
      if (el !== hover.block)
        hover.timer = setTimeout(() => hoverPlace(null), 700);
    } else {
      hoverPlace(el);
    }
  }, near ? 150 : 80);
}

function hoverStart() {
  if (hover.on)
    return;
  hover.on = true;
  hover.button = document.createElement("button");
  hover.button.className = "speechd-reader-ui speechd-reader-play";
  hover.button.textContent = "▶";
  hover.button.title = browser.i18n.getMessage("playTitle");
  hover.button.hidden = true;
  hover.button.addEventListener("mouseenter", () => clearTimeout(hover.timer));
  hover.button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const block = hover.block;
    hoverPlace(null);
    if (block)
      start(unitsFrom(block));
  });
  document.documentElement.append(hover.button);
  document.addEventListener("mousemove", onHoverMove, {passive: true});
  window.addEventListener("scroll", () => hoverPlace(null), {passive: true});
  // the page may load more text later
  new MutationObserver(() => { hover.blocks = null; })
    .observe(document.body, {childList: true, subtree: true});
}

function hoverStop() {
  if (!hover.on)
    return;
  hover.on = false;
  document.removeEventListener("mousemove", onHoverMove);
  hover.button.remove();
}

/* ---------- the floating panel: the popup's controls, kept in the page ---------- */

const panel = {host: null, root: null, el: {}};

const PANEL_CSS = `
:host { all: initial; }
.bar {
  position: fixed; z-index: 2147483647; display: flex; flex-wrap: wrap;
  align-items: center; gap: 4px; max-width: calc(100vw - 16px); box-sizing: border-box;
  padding: 4px 6px; border-radius: 8px; border: 1px solid #8f8f9d;
  background: #f9f9fb; color: #15141a; font: 13px/1.3 system-ui, sans-serif;
  box-shadow: 0 2px 8px rgba(0, 0, 0, .3); user-select: none;
}
@media (prefers-color-scheme: dark) {
  .bar { background: #2b2a33; color: #fbfbfe; border-color: #5b5b66; }
  button, select { background: #42414d; color: #fbfbfe; border-color: #5b5b66; }
}
button, select {
  font: inherit; margin: 0; padding: 3px 7px; border: 1px solid #c4c4c9;
  border-radius: 4px; background: #fff; color: inherit; cursor: pointer;
}
button:disabled { opacity: .45; cursor: default; }
select { max-width: 9em; padding: 2px; }
.grip { cursor: move; padding: 0 2px; opacity: .6; font-size: 15px; }
.main { font-weight: 600; }
.speed { display: flex; align-items: center; gap: 3px; }
input[type=range] { width: 80px; margin: 0; }
.val { min-width: 2.2em; text-align: end; font-variant-numeric: tabular-nums; opacity: .8; }
.close { border: none; background: none; padding: 2px 5px; opacity: .7; }
`;

function msg(name) {
  return browser.i18n.getMessage(name);
}

function panelButton(text, title, onclick, cls = "") {
  const b = document.createElement("button");
  b.textContent = text;
  b.title = title;
  if (cls)
    b.className = cls;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onclick();
  });
  return b;
}

async function panelLanguages(select) {
  const names = new Intl.DisplayNames([navigator.language], {type: "language"});
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = msg("popLangAuto");
  select.append(auto);
  let accept = [];
  try { accept = await browser.i18n.getAcceptLanguages(); } catch (e) { /* none */ }
  const codes = new Set([...accept, navigator.language, document.documentElement.lang || "en",
    "en", "ru", "uk", "de", "fr", "es", "it", "pl", "cs", "pt", "zh", "ja"]
    .map((c) => String(c).split(/[-_]/)[0].toLowerCase())
    .filter((c) => /^[a-z]{2,3}$/.test(c)));
  const name = (c) => { try { return names.of(c); } catch (e) { return c; } };
  for (const c of [...codes].sort((a, b) => name(a).localeCompare(name(b)))) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = name(c) + " (" + c + ")";
    select.append(o);
  }
  select.value = langOverride || "";
}

async function panelRate(change) {
  let settings = {rate: null};
  try {
    settings = Object.assign(settings, (await browser.storage.local.get("settings")).settings);
    if (change !== undefined) {
      settings.rate = change;
      await browser.storage.local.set({settings});
    }
  } catch (e) { /* storage unavailable: keep the default */ }
  const {range, val, reset} = panel.el;
  range.value = settings.rate === null ? 0 : settings.rate;
  val.textContent = settings.rate === null ? "" : settings.rate;
  reset.disabled = settings.rate === null;
}

/* what the other tabs do: the panel of a quiet tab stops or pauses the one
 * that speaks */
const busy = {speaking: false, own: false, paused: false};

function panelUpdate() {
  if (!panel.host)
    return;
  const {pause, stopB} = panel.el;
  const other = !reader.active && busy.speaking && !busy.own;
  pause.disabled = stopB.disabled = !reader.active && !other;
  pause.textContent = (other ? busy.paused : reader.paused) ? "▶" : "⏸";
  panel.el.lang.value = langOverride || "";
}

function panelClamp(x, y) {
  const bar = panel.el.bar;
  const w = bar.offsetWidth, h = bar.offsetHeight;
  x = Math.min(Math.max(x, 0), Math.max(window.innerWidth - w, 0));
  y = Math.min(Math.max(y, 0), Math.max(window.innerHeight - h, 0));
  bar.style.left = x + "px";
  bar.style.top = y + "px";
  bar.style.right = bar.style.bottom = "auto";
  bar.style.transform = "none";
  return [x, y];
}

function panelDrag(e) {
  if (e.button !== 0)
    return;
  e.preventDefault();
  const r = panel.el.bar.getBoundingClientRect();
  const dx = e.clientX - r.left, dy = e.clientY - r.top;
  let pos = [r.left, r.top];
  const move = (m) => { pos = panelClamp(m.clientX - dx, m.clientY - dy); };
  const up = () => {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mouseup", up, true);
    browser.storage.local.set({panelPos: {x: pos[0], y: pos[1]}}).catch(() => {});
  };
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", up, true);
}

function panelResize() {
  if (panel.host && panel.el.bar.style.top)
    panelClamp(parseFloat(panel.el.bar.style.left), parseFloat(panel.el.bar.style.top));
}

async function panelShow() {
  if (panel.host)
    return;
  const host = document.createElement("div");
  host.className = "speechd-reader-ui speechd-reader-panel";
  const root = host.attachShadow({mode: "closed"});
  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", msg("extName"));
  // until it is placed: at the bottom in the middle, like a player
  bar.style.left = "50%";
  bar.style.bottom = "16px";
  bar.style.transform = "translateX(-50%)";

  const grip = document.createElement("span");
  grip.className = "grip";
  grip.textContent = "⠿";
  grip.title = msg("panelMove");
  grip.addEventListener("mousedown", panelDrag);

  const el = panel.el;
  el.bar = bar;
  const read = panelButton("▶ " + msg("popRead"), msg("popReadTitle"), async () => {
    const r = await act({action: "auto"});
    if (r && r.error) notice(r.error);
  }, "main");
  el.pause = panelButton("⏸", msg("popPause"), () => {
    if (reader.active)
      act({action: "toggle-pause"});
    else
      browser.runtime.sendMessage({type: "pause-any"}).catch(() => {});
  });
  el.stopB = panelButton("⏹", msg("popStop"), () => {
    pickerEnd();
    if (reader.active)
      stop();
    else
      browser.runtime.sendMessage({type: "stop-any"}).catch(() => {});
  });
  const pick = panelButton("🎯", msg("popPickTitle"), () => pickerStart());
  const page = panelButton("📄", msg("popPageTitle"), async () => {
    const r = await act({action: "page"});
    if (r && r.error) notice(r.error);
  });

  el.lang = document.createElement("select");
  el.lang.title = msg("popLang");
  el.lang.addEventListener("change", () => {
    langOverride = el.lang.value || null;
  });

  const speed = document.createElement("span");
  speed.className = "speed";
  speed.title = msg("popSpeed");
  el.range = document.createElement("input");
  el.range.type = "range";
  el.range.min = -100;
  el.range.max = 100;
  el.range.step = 5;
  el.range.addEventListener("change", () => panelRate(Number(el.range.value)));
  el.range.addEventListener("input", () => { el.val.textContent = el.range.value; });
  el.val = document.createElement("span");
  el.val.className = "val";
  el.reset = panelButton("↺", msg("popSpeedDefault"), () => panelRate(null));
  speed.append("🐢", el.range, el.val, el.reset);

  const close = panelButton("✕", msg("panelClose"), panelHide, "close");
  bar.append(grip, read, el.pause, el.stopB, pick, page, el.lang, speed, close);
  root.append(style, bar);
  panel.host = host;
  panel.root = root;
  document.documentElement.append(host);
  window.addEventListener("resize", panelResize, {passive: true});

  panelUpdate();
  panelLanguages(el.lang);
  panelRate();
  browser.runtime.sendMessage({type: "status"}).then((s) => {
    if (s && s.speakingTab !== null && s.speakingTab !== undefined) {
      Object.assign(busy, {speaking: true, own: s.speakingTab === s.you, paused: !!s.paused});
      panelUpdate();
    }
  }).catch(() => {});
  try {
    const {panelPos} = await browser.storage.local.get("panelPos");
    if (panelPos && Number.isFinite(panelPos.x) && Number.isFinite(panelPos.y))
      panelClamp(panelPos.x, panelPos.y);
  } catch (e) { /* default place */ }
}

function panelHide() {
  if (!panel.host)
    return;
  window.removeEventListener("resize", panelResize);
  panel.host.remove();
  panel.host = panel.root = null;
  panel.el = {};
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
    return start(pageUnits(document.body, true));
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
    panelUpdate();
    return {ok: true, paused: reader.paused};
  case "set-lang":
    langOverride = msg.lang || null;
    panelUpdate();
    return {ok: true};
  case "buttons":
    if (msg.on) hoverStart(); else hoverStop();
    return {ok: true};
  case "panel":
    await panelShow();
    return {ok: true};
  case "panel-hide":
    panelHide();
    return {ok: true};
  case "attach":       // injected by now; nothing more to do
  case "state":
    return {active: reader.active, paused: reader.paused, picking: picker.on, buttons: hover.on,
            panel: !!panel.host,
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
  if (msg.type === "busy") {
    Object.assign(busy, {speaking: msg.speaking, own: msg.own, paused: msg.paused});
    panelUpdate();
  }
});

/* the panel is on by default; both settings and the panel's place follow
 * changes made in any tab */
function applySettings(s = {}) {
  if (s.buttons !== false) hoverStart(); else hoverStop();
  if (s.panel !== false) panelShow(); else panelHide();
}
browser.storage.local.get("settings").then((r) => applySettings(r.settings))
  .catch(() => applySettings());
browser.storage.onChanged.addListener((changes) => {
  if (changes.settings) {
    const o = changes.settings.oldValue || {}, n = changes.settings.newValue || {};
    if (o.buttons !== n.buttons || o.panel !== n.panel)
      applySettings(n);
  }
  const p = changes.panelPos && changes.panelPos.newValue;
  if (p && panel.host && Number.isFinite(p.x) && Number.isFinite(p.y))
    panelClamp(p.x, p.y);
});

window.__speechdReader = {act, collectUnits, articleUnits, pageUnits, sentencesOf, unitText};
})();
