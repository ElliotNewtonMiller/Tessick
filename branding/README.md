# Tessick's logo

| File | What it is |
| --- | --- |
| `tessick-logo-white.svg` | The full logo, the mark and the word, for dark backgrounds. |
| `tessick-logo-black.svg` | The same for light backgrounds. The README shows one or the other, following GitHub's theme. |
| `tessick-mark.svg` | The mark alone (the T with a check): the favicon, and wherever space is short. |
| `tessick-wordmark-white.svg` | The word "TESSiCK" alone, white with the gradient dot, for dark backgrounds. |
| `tessick-wordmark-black.svg` | The same in black, for light backgrounds. |
| `tessick-social-preview-logo.png` | GitHub's social preview (1280 × 640), shown when a link to the repo is shared. It's uploaded in the repo's Settings → General, so changing this file alone changes nothing. Its GIMP file (`.xcf`) is kept out of git. |
| `*.inkscape.svg` | Elliot's Inkscape files for the mark and the wordmarks: edit these, then make clean copies (below). |

The clean copies keep only what they draw: no editor metadata or unused gradients, the mark cropped to its artwork (`viewBox` `10 14 108 72`), and the word already turned into a path, so no font is needed to show it.

**The full logos** are the mark and a wordmark side by side: the word is 13/22 of the mark's height, centred on it, with a gap of 5/22 of its height. After changing the mark or a wordmark, rebuild them to match.

**The web app** has its own copies in `apps/web/src/assets/`: `tessick-mark.svg` (the header, the sign-in page, the loading screen and the favicon) and `tessick-wordmark.svg` (the white wordmark: the header and the sign-in page). After changing a logo here, copy it there too.
