#!/usr/bin/env bash
# Downloads the background music (all public domain, from FreePD via the
# SoundSafari/CC0-1.0-Music mirror on GitHub) and re-encodes it as small
# AAC .m4a files, which every browser can play (Safari included).
#
#   bash scripts/build-music.sh
#
# To swap a track, change its line below (any file in that repo's freepd.com
# folder works), rerun, and update CREDITS.md.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=apps/web/public/music
SRC=https://raw.githubusercontent.com/SoundSafari/CC0-1.0-Music/main/freepd.com
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

# output name | FreePD file name
while IFS='|' read -r name file; do
  url="$SRC/$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$file")"
  curl -fsSL -o "$TMP/in.mp3" "$url"
  # 80 kbps stereo AAC, loudness-matched so switching rooms doesn't jump in volume.
  ffmpeg -nostdin -v error -y -i "$TMP/in.mp3" -map_metadata -1 -af loudnorm=I=-20:TP=-2 -ar 44100 -c:a aac -b:a 80k -movflags +faststart "$OUT/$name.m4a"
  echo "$OUT/$name.m4a $(du -k "$OUT/$name.m4a" | cut -f1) KB"
done <<'EOF'
lobby|Infinite Wonder.mp3
source_family|Groovin.mp3
synanon|BeBop for Joey.mp3
rajneeshpuram|Infinite Peace.mp3
EOF
