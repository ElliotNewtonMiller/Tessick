# Tessick's logo

| File | What it is |
| --- | --- |
| `tessick-mark.svg` | The mark (the T with a check), cropped to the artwork and stripped to what it draws. Use this one. |
| `tessick-mark.inkscape.svg` | The same mark as drawn in Inkscape, on its 120 × 100 canvas. Edit this one, then export a clean copy (below). |
| `tessick-wordmark.webp` | The word "TESSiCK" in white, for dark backgrounds (376 × 62). |

The web app has its own copies in `apps/web/src/assets/`: the header, the sign-in page, the loading screen and the browser tab's icon. After changing a logo here, copy it there too.

**After editing the mark in Inkscape,** make the clean copy: File → Save As → Optimized SVG, or remove the editor's metadata and unused gradients by hand. Then set `viewBox` to the artwork's bounds plus a small margin (now `10 14 108 72`).
