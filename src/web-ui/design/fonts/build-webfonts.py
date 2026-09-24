#!/usr/bin/env python3
"""
design/fonts/build-webfonts.py - rebuild the WOFF2 files global.css serves.

Why (V3.10): the console shipped both variable fonts as raw TTF (658 KB) and
the first chat paint waited on them. Served as WOFF2, split into a Latin
subset that nearly every screen needs and a full-coverage file the browser
only fetches when a character outside that range actually appears, the first
paint needs ~99 KB instead.

Licensing (SIL OFL 1.1, see the *-OFL.txt files next to the sources):
  - Space Grotesk declares no Reserved Font Name, so its subset keeps its name.
  - IBM Plex Sans declares the Reserved Font Name "Plex". A subset is a
    Modified Version, and a Modified Version may not use a Reserved Font Name,
    so the Latin subset is RENAMED to "Ashlr Sans" in its name table (and
    served under that CSS family). The full-coverage file is the original font
    with WOFF2 compression only - no glyph, metric or name changes - which the
    OFL FAQ treats as the same font, so it keeps IBM's names.
  The OFL texts stay beside the sources and are shipped in public/licenses/.

Requires fontTools with brotli:  python3 -m pip install 'fonttools[woff]'
Run from this directory:          python3 build-webfonts.py
"""
from fontTools import subset
from fontTools.ttLib import TTFont

# Google Fonts' "latin" range plus the UI symbols Verse draws in text
# (arrows, keyboard glyphs, math comparisons, check marks).
LATIN = (
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,"
    "U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+21B5,U+21E7,"
    "U+2212,U+2215,U+2248,U+2260,U+2264-2265,U+2318,U+2325,U+23CE,U+2713,"
    "U+2715,U+25B2,U+25BC,U+25CF,U+FEFF,U+FFFD"
)

RENAMED_FAMILY = "Ashlr Sans"


def rename(font: TTFont, family: str) -> None:
    """Replace every name-table string that carries the original family name."""
    name = font["name"]
    postscript_family = family.replace(" ", "")
    for record in name.names:
        text = record.toUnicode()
        if record.nameID in (1, 16, 21):  # family, typographic family, WWS family
            record.string = family
        elif record.nameID in (3, 4):  # unique id, full name
            record.string = text.replace("IBM Plex Sans", family)
        elif record.nameID in (6, 25):  # PostScript name, variations PS prefix
            record.string = text.replace("IBMPlexSans", postscript_family)
    # Any remaining mention (e.g. a variable instance name) must not keep the RFN.
    for record in name.names:
        if "Plex" in record.toUnicode() and record.nameID not in (0, 7, 13, 14):
            record.string = record.toUnicode().replace("IBM Plex Sans", family).replace("IBMPlexSans", postscript_family).replace("Plex", "Ashlr")


def latin_subset(src: str, out: str, family: str | None) -> None:
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    font = subset.load_font(src, options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=subset.parse_unicodes(LATIN))
    subsetter.subset(font)
    if family is not None:
        rename(font, family)
    subset.save_font(font, out, options)


def full_woff2(src: str, out: str) -> None:
    font = TTFont(src)
    font.flavor = "woff2"
    font.save(out)


if __name__ == "__main__":
    latin_subset("IBMPlexSans.ttf", "AshlrSans-latin.woff2", RENAMED_FAMILY)
    full_woff2("IBMPlexSans.ttf", "IBMPlexSans-full.woff2")
    latin_subset("SpaceGrotesk.ttf", "SpaceGrotesk-latin.woff2", None)
    full_woff2("SpaceGrotesk.ttf", "SpaceGrotesk-full.woff2")
