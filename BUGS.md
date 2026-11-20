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
- **Table reading order.** Tables seem to be read in some other order, not
  row by row; to check. (2026-11-17)
