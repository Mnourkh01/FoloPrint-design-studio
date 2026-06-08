#!/usr/bin/env bash
# One-off: fetch curated OFL/Apache fonts from the official google/fonts repo into
# packages/renderer/fonts/<key>/. Each line: key|licenseDir|familyDir|ttfCandidates(comma)
# We try each ttf candidate until one returns a valid TrueType/OpenType file, then
# grab the license file (OFL.txt or LICENSE.txt) from the family dir.
set -u
BASE="https://raw.githubusercontent.com/google/fonts/main"
ROOT="$(cd "$(dirname "$0")/.." && pwd)/packages/renderer/fonts"
cd "$ROOT" || exit 1

FONTS=(
  "anton|ofl|anton|Anton-Regular.ttf"
  "bebas-neue|ofl|bebasneue|BebasNeue-Regular.ttf"
  "archivo-black|ofl|archivoblack|ArchivoBlack-Regular.ttf"
  "bungee|ofl|bungee|Bungee-Regular.ttf"
  "pacifico|ofl|pacifico|Pacifico-Regular.ttf"
  "lobster|ofl|lobster|Lobster-Regular.ttf"
  "dancing-script|ofl|dancingscript|static/DancingScript-Bold.ttf,DancingScript-Bold.ttf,static/DancingScript-Regular.ttf"
  "permanent-marker|apache|permanentmarker|PermanentMarker-Regular.ttf"
  "bangers|ofl|bangers|Bangers-Regular.ttf"
  "luckiest-guy|apache|luckiestguy|LuckiestGuy-Regular.ttf"
  "righteous|ofl|righteous|Righteous-Regular.ttf"
  "montserrat|ofl|montserrat|static/Montserrat-Bold.ttf,Montserrat-Bold.ttf"
  "poppins|ofl|poppins|Poppins-SemiBold.ttf,Poppins-Bold.ttf,Poppins-Regular.ttf"
  "lora|ofl|lora|static/Lora-Regular.ttf,Lora-Regular.ttf"
  "dm-serif-display|ofl|dmserifdisplay|DMSerifDisplay-Regular.ttf"
  "alfa-slab-one|ofl|alfaslabone|AlfaSlabOne-Regular.ttf"
  "cairo|ofl|cairo|static/Cairo-Bold.ttf,Cairo-Bold.ttf,static/Cairo-Regular.ttf"
  "tajawal|ofl|tajawal|Tajawal-Bold.ttf,Tajawal-Regular.ttf"
)

ok=0; fail=0
is_ttf() {
  # first 4 bytes: 00 01 00 00 (TTF), 'OTTO' (CFF), 'true', or 'ttcf'
  local sig
  sig=$(head -c4 "$1" | od -An -tx1 | tr -d ' \n')
  [[ "$sig" == "00010000" || "$sig" == "4f54544f" || "$sig" == "74727565" || "$sig" == "74746366" ]]
}

for row in "${FONTS[@]}"; do
  IFS='|' read -r key lic fam cands <<<"$row"
  mkdir -p "$key"
  got=""
  IFS=',' read -ra list <<<"$cands"
  for c in "${list[@]}"; do
    fname="$(basename "$c")"
    url="$BASE/$lic/$fam/$c"
    curl -fsSL "$url" -o "$key/$fname" 2>/dev/null
    if [[ -s "$key/$fname" ]] && is_ttf "$key/$fname"; then
      got="$fname"; break
    else
      rm -f "$key/$fname"
    fi
  done
  if [[ -z "$got" ]]; then
    echo "FAIL  $key (no valid ttf from: $cands)"; fail=$((fail+1)); continue
  fi
  # license file
  if curl -fsSL "$BASE/$lic/$fam/OFL.txt" -o "$key/OFL.txt" 2>/dev/null && [[ -s "$key/OFL.txt" ]]; then :;
  elif curl -fsSL "$BASE/$lic/$fam/LICENSE.txt" -o "$key/LICENSE.txt" 2>/dev/null && [[ -s "$key/LICENSE.txt" ]]; then :;
  else echo "WARN  $key license file not found"; fi
  sz=$(wc -c < "$key/$got" | tr -d ' ')
  echo "OK    $key -> $got (${sz}b)"; ok=$((ok+1))
done
echo "---- done: $ok ok, $fail fail ----"
