# Speech Dispatcher Reader

A Firefox extension that reads web pages aloud through Speech Dispatcher.
It has no voices of its own: every sentence goes to speechd with its
language, and speechd speaks it with the module and voice configured for
that language (`LanguageDefaultModule`, the module's voice settings).

What it reads:

- the selection, or else the main text, found with Readability (as in
  Firefox's Reader View) on a copy of the page, so the page itself is not
  changed and the text is highlighted where it is;
- "read from here" (context menu): from that block to the end of the article;
- "Choose what to read…": an element picker (mouse or keyboard) for pages
  where Readability picks the wrong part.

The language of each block: its own `lang` attribute, else the browser's
language detection (the page's `<html lang>` is often just the site's
template), else the page language. It can be fixed by hand in the popup.

Layout:

- `extension/` — the WebExtension (Readability.js from Mozilla, Apache-2.0,
  in `extension/lib/`);
- `host/speechd-reader-host` — the native messaging host (Python, uses the
  `speechd` module of speech-dispatcher); `host/install.sh` registers it;
- `tests/` — host protocol tests (`python3 -I tests/test_host.py`).

Controls: a floating reading panel on the page (on by default; it keeps
its place across tabs, and its stop and pause act on whichever tab speaks),
▶ buttons next to paragraphs, the toolbar popup and the context menu.
Without extra rights the extension enters a page only after a user action
(opening the popup, a menu item, a shortcut). "On all sites by itself" in
the popup asks Firefox for the optional right to read all sites; then the
panel and the buttons appear on every page by themselves. The text still
goes only to Speech Dispatcher on this computer.

Shortcuts: Alt+Shift+R read, Alt+Shift+C choose, Alt+Shift+P pause,
Alt+Shift+X stop.
