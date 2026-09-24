# Local Universe typography

Unmodified variable fonts, downloaded on 2026-09-08 from the Google Fonts
repository. Fonts are served by this local application, not a remote font service.

- [Space Grotesk](https://github.com/google/fonts/tree/main/ofl/spacegrotesk): display and brand, weight 300–700.
  SHA-256 `acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72`.
- [IBM Plex Sans](https://github.com/google/fonts/tree/main/ofl/ibmplexsans): interface text, variable width and weight.
  SHA-256 `3b031aa4216174205bd8471f88a49b91f093169e9e87bd5262242bc5967fe2e3`.

Both are licensed under SIL OFL 1.1. The adjacent copyright/license files must
remain with the source. Identical copies in `../../public/licenses/` are emitted
by Vite into the distributed application.

## What the app serves (V3.10)

The `.ttf` files above are the untouched sources. `global.css` serves WOFF2
files generated from them by `build-webfonts.py` (fontTools + brotli):

| File | What it is | Size |
|---|---|---|
| `AshlrSans-latin.woff2` | IBM Plex Sans, Latin + UI-symbol subset, **renamed** | ~73 KB |
| `IBMPlexSans-full.woff2` | IBM Plex Sans, complete, WOFF2 compression only | ~230 KB |
| `SpaceGrotesk-latin.woff2` | Space Grotesk, Latin + UI-symbol subset | ~28 KB |
| `SpaceGrotesk-full.woff2` | Space Grotesk, complete, WOFF2 compression only | ~49 KB |

A page with only Latin text loads the two `-latin` files (~101 KB instead of
658 KB of TTF). The `-full` files are declared without a `unicode-range` and
before the subsets, so a browser fetches one only when a character outside the
subset appears on screen.

### License review (done for V3.10 — redo it if you change these files)

- **Space Grotesk** declares no Reserved Font Name, so its subset keeps its name.
- **IBM Plex Sans** declares the Reserved Font Name **"Plex"**. Subsetting makes a
  Modified Version (OFL §3), which may not use a Reserved Font Name. The subset's
  name table therefore says **"Ashlr Sans"** (family, full, PostScript and
  variation-prefix names; IBM's copyright and trademark notices are kept), and
  CSS serves it under that family (`--font-ui` in `global.css`).
- The `-full` files change nothing but the container (WOFF2 compression), which
  the OFL FAQ does not treat as a modification, so they keep the original names.
- Every generated file stays under OFL 1.1; the license texts ship with the app.

Do not subset or otherwise modify these fonts in any other way without repeating
this review.
