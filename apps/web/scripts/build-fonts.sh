#!/usr/bin/env bash
# Rebuild the two webfonts from their upstream releases.
#
# Anek Latin and Anek Bangla (Ek Type, OFL 1.1) ship as two-axis variable fonts
# — weight AND width — covering every glyph in their scripts. Shipped as
# published that is 552 KB, which on the 4G and low-end Android this market
# actually runs on is several seconds of invisible text.
#
# Two reductions, neither of which costs a design decision:
#
#   1. CLIP THE AXES to the ranges the stylesheet actually names. Nothing uses
#      weight below 400 or above 800. Latin uses width 75–100 (the condensed
#      board voice through to normal body) and never above 100. Bengali does not
#      use the width axis at all, so it is pinned — that alone is 300 KB, and it
#      is why the width axis survives on Latin, which is where the numerals
#      policy puts every route name, time, fare and PNR in both locales anyway.
#
#   2. SUBSET THE CODEPOINTS. Latin keeps Latin-1 plus punctuation and arrows.
#      Bengali deliberately keeps the WHOLE Bengali block rather than only the
#      strings in lib/i18n.ts: operator and place names arrive from the API, so
#      subsetting to known text would render শ্যামলী পরিবহন in a fallback face.
#
#      U+09F3 (৳) is inside that block and must stay, because the taka sign
#      appears on every money figure in BOTH locales.
#
#   Latin   448 KB -> 69 KB
#   Bengali 448 KB -> 129 KB
#
# Requires: python -m pip install fonttools brotli
set -euo pipefail

PY="${PYTHON:-python}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/app/fonts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

LATIN_SRC="https://fonts.gstatic.com/s/aneklatin/v11/co3DmWZulTRoU4a8dqrWo6Tppg.woff2"
BANGLA_SRC="https://fonts.gstatic.com/s/anekbangla/v16/_gP81R38qTExHg-17BhM6lSkavtLoQ.woff2"

echo "→ Anek Latin"
curl -fsS -o "$TMP/latin.woff2" "$LATIN_SRC"
"$PY" -m fontTools.varLib.instancer "$TMP/latin.woff2" "wdth=75:100" "wght=400:800" \
  -o "$TMP/latin.ttf" --quiet
"$PY" -m fontTools.subset "$TMP/latin.ttf" \
  --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+20AC,U+2122,U+2212,U+2190-2193" \
  --layout-features="*" --no-hinting \
  --flavor=woff2 --output-file="$OUT/anek-latin-subset.woff2"

echo "→ Anek Bangla"
curl -fsS -o "$TMP/bangla.woff2" "$BANGLA_SRC"
"$PY" -m fontTools.varLib.instancer "$TMP/bangla.woff2" "wdth=100" "wght=400:800" \
  -o "$TMP/bangla.ttf" --quiet
# KEEP EVERY LAYOUT FEATURE. This line used to enumerate them, on the reasoning
# that Bengali shaping needs the conjunct and reordering features and so those
# should be named explicitly. That reasoning is exactly backwards, and it
# shipped broken Bangla for it.
#
# An enumerated list can only be wrong in one direction: a feature you forget is
# a feature that silently disappears. This one forgot the GPOS mark-positioning
# features — abvm, blwm and dist — which are what put a matra under, over or
# beside its consonant. Without them the u-kar in দেখুন stops being a mark at
# all and takes its own advance width, so the word renders as দেখনু. It is
# legible enough to skim past in review and completely wrong to a reader.
#
# It also dropped cjct (conjuncts), nukt (nukta forms, so ড় ঢ় য়) and rvrn,
# which a variable font needs to substitute correctly across the weight axis.
#
# A layout table is a few KB against 129 KB of outlines. There was never a
# saving here worth one misspelt word, let alone every one of them.
"$PY" -m fontTools.subset "$TMP/bangla.ttf" \
  --unicodes="U+0964-0965,U+0980-09FE,U+200C-200D,U+25CC,U+0020-007E" \
  --layout-features="*" \
  --no-hinting --desubroutinize \
  --flavor=woff2 --output-file="$OUT/anek-bangla-subset.woff2"

echo
ls -l "$OUT"
"$PY" - "$OUT" <<'PYEOF'
import sys, pathlib
from fontTools.ttLib import TTFont
for f in sorted(pathlib.Path(sys.argv[1]).glob('*.woff2')):
    t = TTFont(f)
    axes = [(a.axisTag, a.minValue, a.maxValue) for a in t['fvar'].axes]
    print(f"{f.name}: {t['maxp'].numGlyphs} glyphs, axes {axes}")
PYEOF
