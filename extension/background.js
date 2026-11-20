/*
 * Copyright (C) 2026 Grigory Tuboltsev
 * SPDX-License-Identifier: MIT
 *
 * Owns the connection to the native host and decides which tab speaks: one
 * tab at a time, starting in another tab stops the first. The content
 * script of the speaking tab keeps the queue; this only relays.
 */
"use strict";

const HOST = "speechd_reader";
const IDLE_DISCONNECT_MS = 5 * 60 * 1000;

let port = null;
let speakingTab = null;      // tab id whose utterances are in the host
let nextId = 1;
const pending = new Map();   // host id -> {tab, id (the tab's own)}
let idleTimer = null;
let lastError = null;
let paused = false;          // the speaking tab is paused

/* tell every tab's panel who speaks, so it can stop or pause any tab */
async function broadcast() {
  for (const t of await browser.tabs.query({}).catch(() => []))
    browser.tabs.sendMessage(t.id, {type: "busy", speaking: speakingTab !== null,
                                    own: t.id === speakingTab, paused}, {frameId: 0})
      .catch(() => {});
}

function hostPort() {
  if (port)
    return port;
  port = browser.runtime.connectNative(HOST);
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener((p) => {
    const err = p.error ? p.error.message : "the speech host quit";
    port = null;
    lastError = err;
    for (const {tab, id} of pending.values())
      toTab(tab, {type: "event", event: "error", id, message: err});
    pending.clear();
    speakingTab = null;
    paused = false;
    broadcast();
  });
  const settings = currentSettings;
  if (settings.rate !== null)
    port.postMessage({cmd: "rate", value: settings.rate});
  return port;
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (port && pending.size === 0) {
      port.disconnect();
      port = null;
    }
  }, IDLE_DISCONNECT_MS);
}

function toTab(tab, msg) {
  browser.tabs.sendMessage(tab, msg, {frameId: 0}).catch(() => {});
}

function onHostMessage(msg) {
  if (!msg || typeof msg !== "object")
    return;
  if (msg.event === "error" && msg.id == null) {
    lastError = msg.message;
    return;
  }
  const p = pending.get(msg.id);
  if (!p)
    return;
  if (msg.event !== "begin" && msg.event !== "mark")
    pending.delete(msg.id);
  toTab(p.tab, {type: "event", event: msg.event, id: p.id, part: msg.part, message: msg.message});
  touch();
}

/* @except: the tab that asked, which has stopped already */
function stopAll(except = null) {
  if (port)
    port.postMessage({cmd: "stop"});
  // the host answers with cancel events, which the tab would take for
  // "speechd dropped this one, go on": tell it to stop instead
  const tabs = new Set([...pending.values()].map((p) => p.tab));
  if (speakingTab !== null)
    tabs.add(speakingTab);
  pending.clear();
  const was = speakingTab;
  speakingTab = null;
  paused = false;
  tabs.delete(except);
  for (const tab of tabs)
    toTab(tab, {type: "stopped"});
  if (was !== null)
    broadcast();
}

/* settings shared with the popup */
let currentSettings = {rate: null};
browser.storage.local.get("settings").then((r) => {
  if (r.settings)
    currentSettings = Object.assign(currentSettings, r.settings);
});
browser.storage.onChanged.addListener((changes) => {
  if (!changes.settings)
    return;
  const old = currentSettings.rate;
  currentSettings = Object.assign({rate: null, buttons: true}, changes.settings.newValue);
  if (port && currentSettings.rate !== old)
    port.postMessage({cmd: "rate", value: currentSettings.rate});
});

browser.runtime.onMessage.addListener((msg, sender) => {
  const tab = sender.tab ? sender.tab.id : null;
  switch (msg && msg.type) {
  case "speak": {
    if (tab === null || !Array.isArray(msg.parts))
      return;
    if (speakingTab !== null && speakingTab !== tab) {
      stopAll();
    }
    if (speakingTab !== tab) {
      speakingTab = tab;
      paused = false;
      broadcast();
    }
    const id = nextId++;
    pending.set(id, {tab, id: msg.id});
    try {
      hostPort().postMessage({cmd: "speak", id, parts: msg.parts, lang: msg.lang || null});
    } catch (e) {
      pending.delete(id);
      toTab(tab, {type: "event", event: "error", id: msg.id, message: String(e)});
    }
    touch();
    return;
  }
  case "stop":
    if (tab === null || tab === speakingTab)
      stopAll(tab);
    return;
  case "pause":
  case "resume":
    // the tab cancels on pause and speaks the sentences again on resume
    if (tab === null || tab === speakingTab) {
      if (msg.type === "pause" && port) {
        port.postMessage({cmd: "stop"});
        pending.clear();      // their cancel events mean nothing to the tab
      }
      paused = msg.type === "pause";
      broadcast();
    }
    return;
  case "done":        // the tab read to the end or gave up
    if (tab === speakingTab) {
      speakingTab = null;
      paused = false;
      broadcast();
    }
    return;
  case "stop-any":    // a panel in a tab that does not speak
    stopAll();
    return;
  case "pause-any":
    if (speakingTab !== null)
      toTab(speakingTab, {type: "action", action: "toggle-pause"});
    return;
  case "status":
    return Promise.resolve({speakingTab, lastError, paused, you: tab});
  case "run":         // from the popup
    return runInTab(msg.tab, msg.action, {lang: msg.lang, on: msg.on});
  }
});

browser.tabs.onRemoved.addListener((tab) => {
  if (tab === speakingTab)
    stopAll();
});

/* injection on demand: activeTab gives us the page after a user gesture */
async function inject(tab) {
  const [{result}] = await browser.scripting.executeScript({
    target: {tabId: tab}, func: () => typeof window.__speechdReader === "object",
  });
  if (result)
    return;
  await browser.scripting.insertCSS({target: {tabId: tab}, files: ["content/reader.css"]});
  await browser.scripting.executeScript({
    target: {tabId: tab},
    files: ["lib/Readability.js", "content/reader.js"],
  });
}

async function runInTab(tab, action, extra = {}) {
  // the popup asks for the state often: never inject only for that
  if (action === "state") {
    try {
      return await browser.tabs.sendMessage(tab, {type: "action", action}, {frameId: 0});
    } catch (e) {
      return {active: false};
    }
  }
  try {
    await inject(tab);
  } catch (e) {
    return {error: browser.i18n.getMessage("cantRead", e.message)};
  }
  return browser.tabs.sendMessage(tab, Object.assign({type: "action", action}, extra), {frameId: 0});
}

/* with the optional right to every site, the script (▶ buttons, panel)
 * goes into every page by itself; without it, only after a user's action */
const ALL_SITES = {origins: ["<all_urls>"]};
const SCRIPT_ID = "reader";

async function syncAllSites(injectOpen = false) {
  const all = await browser.permissions.contains(ALL_SITES);
  const ours = await browser.scripting.getRegisteredContentScripts({ids: [SCRIPT_ID]});
  if (all && !ours.length) {
    await browser.scripting.registerContentScripts([{
      id: SCRIPT_ID, matches: ["<all_urls>"], runAt: "document_idle",
      js: ["lib/Readability.js", "content/reader.js"], css: ["content/reader.css"],
    }]);
  } else if (!all && ours.length) {
    await browser.scripting.unregisterContentScripts({ids: [SCRIPT_ID]});
  }
  if (all && injectOpen) {
    for (const t of await browser.tabs.query({url: ["http://*/*", "https://*/*", "file:///*"]}))
      inject(t.id).catch(() => {});
  }
}
syncAllSites().catch(() => {});
browser.permissions.onAdded.addListener(() => syncAllSites(true).catch(() => {}));
browser.permissions.onRemoved.addListener(() => syncAllSites().catch(() => {}));

/* context menu: an event page must create it only once */
browser.runtime.onInstalled.addListener(() => {
  browser.menus.create({id: "read-selection", title: browser.i18n.getMessage("menuSelection"), contexts: ["selection"]});
  browser.menus.create({id: "read-from-here", title: browser.i18n.getMessage("menuFromHere"), contexts: ["page", "link", "image"]});
  browser.menus.create({id: "read-article", title: browser.i18n.getMessage("menuArticle"), contexts: ["page"]});
  browser.menus.create({id: "pick-element", title: browser.i18n.getMessage("menuPick"), contexts: ["page"]});
  browser.menus.create({id: "panel", title: browser.i18n.getMessage("menuPanel"), contexts: ["page"]});
});

browser.menus.onClicked.addListener((info, tab) => {
  const extra = {targetElementId: info.targetElementId};
  runInTab(tab.id, info.menuItemId === "read-selection" ? "selection" : info.menuItemId.replace(/^read-/, ""), extra);
});

browser.commands.onCommand.addListener(async (command, tab) => {
  tab = tab || (await browser.tabs.query({active: true, currentWindow: true}))[0];
  if (!tab)
    return;
  if (command === "stop")
    return stopAll();
  if (command === "pause")
    return runInTab(tab.id, "toggle-pause");
  runInTab(tab.id, command === "read-article" ? "auto" : "pick-element");
});
