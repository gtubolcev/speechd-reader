# Known bugs

Open problems found in real use; fix later.

- **Picker can't enter iframes.** On a Claude Docs page
  (claude.ai/artifact/…) the paragraph picker highlights the whole
  `iframe#frame-content` ("0 words") and cannot pick a paragraph inside it.
  The document lives in a (cross-origin) iframe, and the content script is
  injected only into the top frame: no `all_frames` in the manifest,
  `executeScript` without `allFrames`. Needs injection into frames plus
  coordination between frames (the picker, the panel, highlighting).
  Readability is probably blind to such pages for the same reason.
  (2026-11-20)
- **Our keys on pages with accesskeys (partly fixed).** Firefox gives
  Alt+Shift+letter to the page's accesskeys first: on Wikipedia Alt+Shift+R
  opened "Recent changes" and the extension never saw the key. The page's
  script now takes such keys itself, but it is in the page only with the
  "all sites" permission or after the extension was used in the tab once;
  before that the first Alt+Shift+R on Wikipedia still goes to the page.
  Full fix: other default keys (Ctrl+Alt+…?), the user's choice.
  (2026-11-23)

Checked and not reproduced:

- Table reading order (2026-11-17): a test table (thead, rowspan, layout
  table) and a copy of ru.wikipedia "Список самых высоких зданий мира"
  (7 tables, 1553 utterances) are read row by row, cell by cell. Each cell
  is an utterance of its own: numbers without their column names are hard
  to follow; reading a row as one phrase, with header names, is a possible
  improvement. Need the page where the order was wrong. (2026-11-23)
