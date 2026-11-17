/* Copyright (C) 2026 Grigory Tuboltsev; SPDX-License-Identifier: MIT */
"use strict";

const $ = (id) => document.getElementById(id);
let tab = null;
// opened with 📌 as a window of its own: it acts on the active tab of the
// browser window used last, and follows it
const detached = new URLSearchParams(location.search).has("detached");
let browserWindow = null;

document.documentElement.lang = browser.i18n.getUILanguage();
for (const el of document.querySelectorAll("[data-i18n]"))
  el.textContent = browser.i18n.getMessage(el.dataset.i18n);
for (const el of document.querySelectorAll("[data-i18n-title]"))
  el.title = browser.i18n.getMessage(el.dataset.i18nTitle);

function status(text, error = false) {
  $("status").textContent = text || "";
  $("status").classList.toggle("error", error);
}

async function currentTab() {
  if (!detached) {
    [tab] = await browser.tabs.query({active: true, currentWindow: true});
    return;
  }
  if (browserWindow === null)
    browserWindow = (await browser.windows.getLastFocused({windowTypes: ["normal"]})).id;
  [tab] = await browser.tabs.query({active: true, windowId: browserWindow});
}

async function run(action, extra = {}) {
  try {
    await currentTab();
    if (!tab)
      return null;
    const r = await browser.runtime.sendMessage(Object.assign({type: "run", tab: tab.id, action}, extra));
    if (r && r.error)
      status(r.error, true);
    return r;
  } catch (e) {
    status(String(e.message || e), true);
    return null;
  }
}

async function refresh() {
  const s = await run("state");
  if (!s || s.error)
    return;
  $("pause").disabled = $("stop").disabled = !s.active;
  $("pause").textContent = s.paused ? "▶" : "⏸";
  $("lang").value = s.lang || "";
  const bg = await browser.runtime.sendMessage({type: "status"});
  if (bg && bg.lastError)
    status(bg.lastError, true);
}

async function fillLanguages() {
  const names = new Intl.DisplayNames([navigator.language], {type: "language"});
  const codes = new Set([...(await browser.i18n.getAcceptLanguages()), navigator.language,
    "en", "ru", "uk", "de", "fr", "es", "it", "pl", "cs", "pt", "zh", "ja"]
    .map((c) => c.split("-")[0].toLowerCase()));
  for (const c of [...codes].sort((a, b) => names.of(a).localeCompare(names.of(b)))) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = names.of(c) + " (" + c + ")";
    $("lang").append(o);
  }
}

async function loadSettings() {
  const {settings = {rate: null}} = await browser.storage.local.get("settings");
  $("buttons").checked = settings.buttons !== false;
  $("rate-default").checked = settings.rate === null;
  $("rate").value = settings.rate === null ? 0 : settings.rate;
  $("rate").disabled = settings.rate === null;
  $("rate-value").textContent = settings.rate === null ? "" : settings.rate;
}

async function save(change) {
  const {settings = {rate: null}} = await browser.storage.local.get("settings");
  await browser.storage.local.set({settings: Object.assign(settings, change)});
}

function saveRate() {
  const rate = $("rate-default").checked ? null : Number($("rate").value);
  $("rate").disabled = rate === null;
  $("rate-value").textContent = rate === null ? "" : rate;
  save({rate});
}

// the popup gets out of the way; the pinned window stays
const done = () => { if (!detached) window.close(); else refresh(); };
$("auto").onclick = async () => { const r = await run("auto"); if (r && r.ok) done(); };
$("page").onclick = async () => { const r = await run("page"); if (r && r.ok) done(); };
$("pick").onclick = async () => { await run("pick-element"); done(); };
$("pause").onclick = async () => { await run("toggle-pause"); refresh(); };
$("stop").onclick = async () => { await run("stop"); refresh(); };
$("lang").onchange = () => run("set-lang", {lang: $("lang").value});
$("rate").oninput = saveRate;
$("buttons").onchange = () => {
  save({buttons: $("buttons").checked});
  run("buttons", {on: $("buttons").checked});
};
$("rate-default").onchange = saveRate;
$("pin").onclick = () => {
  browser.runtime.sendMessage({type: "detach"});
  window.close();
};
// without the right to every page, the window can act only on pages where
// the extension was started already (activeTab)
const ALL = {origins: ["<all_urls>"]};
$("allow").onclick = async () => {
  await browser.permissions.request(ALL);
  $("allow").hidden = await browser.permissions.contains(ALL);
};

if (detached) {
  document.body.classList.add("detached");
  browser.permissions.contains(ALL).then((yes) => { $("allow").hidden = yes; });
  browser.windows.onFocusChanged.addListener(async (id) => {
    if (id === browser.windows.WINDOW_ID_NONE)
      return;
    const w = await browser.windows.get(id);
    if (w.type === "normal") {
      browserWindow = id;
      refresh();
    }
  });
  browser.tabs.onActivated.addListener(({windowId}) => {
    if (windowId === browserWindow)
      refresh();
  });
  setInterval(refresh, 1000);
}

(async () => {
  await fillLanguages();
  await loadSettings();
  refresh();
})();
