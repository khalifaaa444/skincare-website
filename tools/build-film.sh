#!/usr/bin/env bash
# Pétale — turn your own film clip(s) into the scroll-scrubbed film behind the page.
#
#   tools/build-film.sh --desktop my-film-16x9.mp4 --portrait my-film-9x16.mp4
#
# Samples N frames evenly over each clip (first and last frame included), scales them with
# lanczos, encodes WebP (JPEG if this ffmpeg has no libwebp) into <out>/<variant>/f_0001.<ext>…
# and writes <out>/manifest.json, which the page picks up on its own (SITE.film.source "auto").
# Needs ffmpeg + ffprobe. See film/README.md.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tools/build-film.sh [--desktop FILE] [--portrait FILE] [options]

Turns your own video into the image sequence the site scrubs on scroll, plus film/manifest.json.
Give at least one clip; with both, laptops get the 16:9 one and phones the 9:16 one.

Clips:
  --desktop FILE    16:9 landscape clip (laptops, desktops, tablets held sideways)
  --portrait FILE   9:16 portrait clip (phones)

Options:
  --frames N        frames sampled evenly over each clip, first and last included (default 600;
                    a clip with fewer frames than N keeps all of its own frames)
  --width W         output width in px (default 1920 desktop, 1080 portrait; never upscales)
  --quality Q       WebP quality 1-100 (default 78; mapped onto JPEG if libwebp is missing)
  --focus-x X       0-1, where the crop sits horizontally when the screen is narrower than the
                    clip: 0 left edge, 0.5 centre, 1 right edge (default 0.6 desktop, 0.5 portrait)
  --acts T,T,T,T,T  optional: the five times (seconds into the clip) at which it reaches the five
                    beats - hero, bloom, cream, texture, ritual. Without it the clip is spread
                    evenly over the scroll.
  --lite W          also write a light copy of every frame, W px wide, into <variant>/lite/:
                    phones scrub with it and fetch only the resting frame at full size
                    (default 720 for the portrait clip, none for the desktop clip; 0 = none)
  --jpeg            write JPEG frames even when WebP is available
  --out DIR         output folder (default: film/ in the site root)
  --url PATH        that folder as the page sees it, written into the manifest (default: the
                    folder's path relative to the site root, e.g. film/)
  -h, --help        show this help

Options apply to every clip given in the same run; build the variants in separate runs to give
them different settings. A variant you do not rebuild is kept as long as its folder is there.

Example:
  tools/build-film.sh --desktop renders/peony-16x9.mp4 --portrait renders/peony-9x16.mp4 \
                      --frames 720 --quality 80
EOF
}

die()  { printf 'build-film: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BUILD_TMP=""
trap '[[ -z "$BUILD_TMP" ]] || rm -rf "$BUILD_TMP"; rm -f "${OUT:-/nonexistent}"/.manifest-$$.json' EXIT

DESKTOP="" PORTRAIT="" FRAMES=600 WIDTH="" QUALITY=78 FOCUS="" ACTS="" OUT="" URL="" JPEG=0 LITE=""

need_arg() { [[ $# -ge 2 && -n "${2:-}" ]] || die "$1 needs a value (see --help)"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --desktop)  need_arg "$@"; DESKTOP=$2; shift 2 ;;
    --portrait) need_arg "$@"; PORTRAIT=$2; shift 2 ;;
    --frames)   need_arg "$@"; FRAMES=$2; shift 2 ;;
    --width)    need_arg "$@"; WIDTH=$2; shift 2 ;;
    --quality)  need_arg "$@"; QUALITY=$2; shift 2 ;;
    --focus-x)  need_arg "$@"; FOCUS=$2; shift 2 ;;
    --acts)     need_arg "$@"; ACTS=$2; shift 2 ;;
    --out)      need_arg "$@"; OUT=$2; shift 2 ;;
    --url)      need_arg "$@"; URL=$2; shift 2 ;;
    --lite)     need_arg "$@"; LITE=$2; shift 2 ;;
    --lite=*)   LITE=${1#*=}; shift ;;
    --desktop=*)  DESKTOP=${1#*=}; shift ;;
    --portrait=*) PORTRAIT=${1#*=}; shift ;;
    --frames=*)   FRAMES=${1#*=}; shift ;;
    --width=*)    WIDTH=${1#*=}; shift ;;
    --quality=*)  QUALITY=${1#*=}; shift ;;
    --focus-x=*)  FOCUS=${1#*=}; shift ;;
    --acts=*)     ACTS=${1#*=}; shift ;;
    --out=*)      OUT=${1#*=}; shift ;;
    --url=*)      URL=${1#*=}; shift ;;
    --jpeg)     JPEG=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# ---- checks -------------------------------------------------------------------------------
[[ -n "$DESKTOP$PORTRAIT" ]] || { usage >&2; die "give --desktop FILE and/or --portrait FILE"; }
for f in "$DESKTOP" "$PORTRAIT"; do
  [[ -z "$f" || -f "$f" ]] || die "no such file: $f"
done
command -v ffmpeg  >/dev/null 2>&1 || die "ffmpeg is not installed (https://ffmpeg.org/download.html)"
command -v ffprobe >/dev/null 2>&1 || die "ffprobe is not installed (it ships with ffmpeg)"

is_int()   { [[ "$1" =~ ^[0-9]+$ ]]; }
is_float() { [[ "$1" =~ ^[0-9]*\.?[0-9]+$ ]]; }
is_int "$FRAMES"  && (( FRAMES >= 2 && FRAMES <= 9999 )) || die "--frames must be a whole number from 2 to 9999"
is_int "$QUALITY" && (( QUALITY >= 1 && QUALITY <= 100 )) || die "--quality must be from 1 to 100"
[[ -z "$WIDTH" ]] || { is_int "$WIDTH" && (( WIDTH >= 64 && WIDTH <= 8192 )); } || die "--width must be from 64 to 8192"
[[ -z "$LITE" ]] || { is_int "$LITE" && (( LITE == 0 || (LITE >= 64 && LITE <= 8192) )); } || die "--lite must be 0 or from 64 to 8192"
[[ -z "$FOCUS" ]] || { is_float "$FOCUS" && awk -v x="$FOCUS" 'BEGIN{exit !(x>=0 && x<=1)}'; } || die "--focus-x must be between 0 and 1"
if [[ -n "$ACTS" ]]; then
  [[ "$ACTS" =~ ^[0-9.]+(,[0-9.]+)+$ ]] || die "--acts wants comma-separated seconds, e.g. 0,2.5,5,7.5,10"
  awk -v a="$ACTS" 'BEGIN{n=split(a,t,",");for(i=2;i<=n;i++)if(t[i]+0<t[i-1]+0)exit 1}' \
    || die "--acts times must not go backwards"
fi

# ---- output folder and its URL ----------------------------------------------------------
[[ -n "$OUT" ]] || OUT="$ROOT/film"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
if [[ -z "$URL" ]]; then
  if [[ "$OUT" == "$ROOT" ]]; then URL=""
  elif [[ "$OUT" == "$ROOT"/* ]]; then URL="${OUT#"$ROOT"/}/"
  else
    URL="$(basename "$OUT")/"
    note "note: $OUT is outside the site; the manifest assumes the page sees it as \"$URL\" (set --url to change)"
  fi
fi
[[ -z "$URL" || "$URL" == */ ]] || URL="$URL/"

# ---- encoder -------------------------------------------------------------------------------
ENCODERS=$(ffmpeg -hide_banner -encoders 2>/dev/null || true)
if (( ! JPEG )) && grep -Eq '^ *V[^ ]* +libwebp ' <<<"$ENCODERS"; then
  EXT=webp
  ENC=(-c:v libwebp -lossless 0 -quality "$QUALITY" -compression_level 5 -preset photo -pix_fmt yuv420p)
else
  EXT=jpg
  QV=$(awk -v q="$QUALITY" 'BEGIN{v=int((100-q)/4+2.5); if(v<2)v=2; if(v>31)v=31; print v}')
  ENC=(-c:v mjpeg -q:v "$QV" -pix_fmt yuvj420p)
  (( JPEG )) || note "note: this ffmpeg has no libwebp encoder; writing JPEG frames instead (bigger files)"
fi
if ffmpeg -hide_banner -h full 2>/dev/null | grep -q -- '-fps_mode'; then SYNC=(-fps_mode passthrough); else SYNC=(-vsync 0); fi

json_str() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }

probe() { ffprobe -v error "$@" 2>/dev/null | head -n 1 | tr -d '\r' || true; }

# ---- one variant ---------------------------------------------------------------------------
build_variant() {
  local key=$1 file=$2 defw=$3 deffx=$4 deflite=$5
  local w=${WIDTH:-$defw} lw=${LITE:-$deflite} fx
  fx=$(awk -v x="${FOCUS:-$deffx}" 'BEGIN{printf "%g", x+0}')
  note ""
  note "== $key: $file"

  local size dur packets rot sw sh
  size=$(probe -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$file")
  [[ "$size" =~ ^[0-9]+x[0-9]+ ]] || die "$file: no video stream found"
  sw=${size%%x*}; sh=${size#*x}; sh=${sh%%x*}
  rot=$(probe -select_streams v:0 -show_entries stream_side_data=rotation -of default=nw=1:nk=1 "$file")
  if [[ "$rot" =~ ^-?(90|270)$ ]]; then local t=$sw; sw=$sh; sh=$t; fi
  dur=$(probe -show_entries format=duration -of default=nw=1:nk=1 "$file")
  is_float "$dur" || dur=$(probe -select_streams v:0 -show_entries stream=duration -of default=nw=1:nk=1 "$file")
  is_float "$dur" || dur=""
  packets=$(probe -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of default=nw=1:nk=1 "$file")
  is_int "$packets" || packets=0

  local aspect
  aspect=$(awk -v a="$sw" -v b="$sh" 'BEGIN{printf "%.3f", a/b}')
  if [[ $key == desktop ]] && awk -v r="$aspect" 'BEGIN{exit !(r<1.2)}'; then
    note "warning: $file is ${sw}x${sh} (aspect $aspect); the desktop clip should be landscape 16:9"
  fi
  if [[ $key == portrait ]] && awk -v r="$aspect" 'BEGIN{exit !(r>0.8)}'; then
    note "warning: $file is ${sw}x${sh} (aspect $aspect); the portrait clip should be 9:16"
  fi
  (( w > sw )) && w=$sw
  w=$(( w / 2 * 2 ))
  lw=$(( lw / 2 * 2 ))
  (( lw * 10 < w * 9 )) || lw=0                 # a light copy only pays off when clearly smaller

  # even sampling: frame n of M is kept when it is the nearest source frame to i*(M-1)/(N-1)
  local n=$FRAMES select
  if (( packets > 0 && packets <= n )); then
    n=$packets
    select="null"
    (( packets < FRAMES )) && note "note: the clip has only $packets frames; keeping all of them"
  elif (( packets > 0 )); then
    local r
    r=$(awk -v m="$packets" -v k="$n" 'BEGIN{printf "%.9f", (m-1)/(k-1)}')
    select="select='eq(n,floor(floor(n/$r+0.5)*$r+0.5))'"
  elif [[ -n "$dur" ]]; then
    select="fps=$(awk -v k="$n" -v d="$dur" 'BEGIN{printf "%.9f", k/d}')"
  else
    die "$file: cannot read its length or frame count"
  fi

  local tmp="$OUT/.build-$key-$$"
  rm -rf "$tmp"; mkdir -p "$tmp"
  BUILD_TMP=$tmp
  local lanczos="flags=lanczos+accurate_rnd+full_chroma_int"
  if (( lw > 0 )); then
    mkdir -p "$tmp/lite"
    note "sampling $n frames at ${w}px wide, plus a ${lw}px light copy → $EXT (quality $QUALITY)…"
    # one decode pass, two outputs: the light copy holds exactly the same frames
    ffmpeg -hide_banner -v error -stats -nostdin -y -i "$file" -an -sn -dn -map_metadata -1 \
      -filter_complex "[0:v]$select,split=2[a][b];[a]scale=w=$w:h=-2:$lanczos[full];[b]scale=w=$lw:h=-2:$lanczos[lite]" \
      -map "[full]" "${SYNC[@]}" -frames:v "$n" "${ENC[@]}" "$tmp/f_%04d.$EXT" \
      -map "[lite]" "${SYNC[@]}" -frames:v "$n" "${ENC[@]}" "$tmp/lite/f_%04d.$EXT"
  else
    note "sampling $n frames at ${w}px wide → $EXT (quality $QUALITY)…"
    ffmpeg -hide_banner -v error -stats -nostdin -y -i "$file" -an -sn -dn -map_metadata -1 \
      -vf "$select,scale=w=$w:h=-2:$lanczos" \
      "${SYNC[@]}" -frames:v "$n" "${ENC[@]}" "$tmp/f_%04d.$EXT"
  fi

  local count
  count=$(find "$tmp" -maxdepth 1 -name "f_*.$EXT" | wc -l | tr -d ' ')
  (( count > 0 )) || die "$file: ffmpeg wrote no frames"
  local fsize fw fh bytes
  fsize=$(probe -show_entries stream=width,height -of csv=s=x:p=0 "$tmp/f_0001.$EXT")
  fw=${fsize%%x*}; fh=${fsize#*x}; fh=${fh%%x*}
  is_int "$fw" && is_int "$fh" || { fw=$w; fh=$(awk -v a="$w" -v b="$sw" -v c="$sh" 'BEGIN{printf "%d", a*c/b}'); }
  bytes=$(cat "$tmp"/f_*."$EXT" | wc -c | tr -d ' ')

  local lite_json="" lcount lsize lfw lfh lbytes
  if (( lw > 0 )); then
    lcount=$(find "$tmp/lite" -maxdepth 1 -name "f_*.$EXT" | wc -l | tr -d ' ')
    lsize=$(probe -show_entries stream=width,height -of csv=s=x:p=0 "$tmp/lite/f_0001.$EXT")
    lfw=${lsize%%x*}; lfh=${lsize#*x}; lfh=${lfh%%x*}
    if [[ "$lcount" == "$count" ]] && is_int "$lfw" && is_int "$lfh"; then
      lbytes=$(cat "$tmp"/lite/f_*."$EXT" | wc -c | tr -d ' ')
      lite_json=$(printf '{ "dir": %s, "width": %d, "height": %d, "ext": "%s", "bytes": %d }' \
        "$(json_str "$URL$key/lite/")" "$lfw" "$lfh" "$EXT" "$lbytes")
    else
      note "warning: the light copy came out incomplete ($lcount of $count frames); leaving it out"
      rm -rf "$tmp/lite"
    fi
  fi

  local acts=""
  if [[ -n "$ACTS" ]]; then
    if [[ -n "$dur" ]]; then
      acts=$(awk -v a="$ACTS" -v d="$dur" -v k="$count" 'BEGIN{
        n=split(a,t,","); s="";
        for(i=1;i<=n;i++){ x=int(t[i]/d*(k-1)+0.5); if(x<0)x=0; if(x>k-1)x=k-1; s=s (i>1?",":"") x }
        print s }')
    else
      note "warning: cannot read the clip length; ignoring --acts for $key"
    fi
  fi

  {
    printf '{\n'
    printf '  "dir": %s,\n' "$(json_str "$URL$key/")"
    printf '  "count": %d,\n  "width": %d,\n  "height": %d,\n  "ext": "%s",\n' "$count" "$fw" "$fh" "$EXT"
    printf '  "focusX": %s,\n  "bytes": %d,\n' "$fx" "$bytes"
    [[ -n "$acts" ]] && printf '  "acts": [%s],\n' "$acts"
    [[ -n "$lite_json" ]] && printf '  "lite": %s,\n' "$lite_json"
    printf '  "source": %s\n}\n' "$(json_str "$(basename "$file")")"
  } > "$tmp/variant.json"

  rm -rf "${OUT:?}/$key"
  mv "$tmp" "$OUT/$key"
  BUILD_TMP=""
  note "$key: $count frames, ${fw}x${fh}, $(awk -v b="$bytes" 'BEGIN{printf "%.1f", b/1048576}') MB"
  [[ -z "$lite_json" ]] || note "$key/lite: ${lfw}x${lfh}, $(awk -v b="$lbytes" 'BEGIN{printf "%.1f", b/1048576}') MB"
}

[[ -n "$DESKTOP"  ]] && build_variant desktop  "$DESKTOP"  1920 0.6 0
[[ -n "$PORTRAIT" ]] && build_variant portrait "$PORTRAIT" 1080 0.5 720

# ---- manifest: every variant whose folder is complete ------------------------------------
list=()
for key in desktop portrait; do
  [[ -f "$OUT/$key/variant.json" && -n "$(find "$OUT/$key" -maxdepth 1 -name 'f_0001.*' -print -quit)" ]] && list+=("$key")
done
(( ${#list[@]} )) || die "no complete variant in $OUT"
tmpm="$OUT/.manifest-$$.json"
{
  printf '{\n  "version": 1,\n  "generator": "tools/build-film.sh",\n  "variants": {\n'
  for i in "${!list[@]}"; do
    key=${list[$i]}
    body=$(sed -e '1!s/^/    /' "$OUT/$key/variant.json")
    printf '    "%s": %s' "$key" "$body"
    if (( i < ${#list[@]} - 1 )); then printf ',\n'; else printf '\n'; fi
  done
  printf '  }\n}\n'
} > "$tmpm"
mv "$tmpm" "$OUT/manifest.json"

note ""
note "wrote $OUT/manifest.json (${list[*]})"
note "reload the page: with SITE.film.source \"auto\" it now plays these frames."
note "to go back to the procedural film, delete $OUT/manifest.json."
