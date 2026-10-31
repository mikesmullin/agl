#!/usr/bin/env bash
# Compile-time benchmark: cargo vs blaze on incremental one-function edits.
#
# Protocol (per tmp/FAST_RUST.md, whose published Linux x86-64 figure is ~11x
# on edits):
#   1. One cold build per tool, timed but reported separately — Blaze has no
#      shortcut for the first build, so including it would flatter cargo.
#   2. N rounds. Each round touches ONE function body (a real edit that
#      changes codegen, not a whitespace poke), then rebuilds.
#   3. Report median and min/max, not a single run.
#
# Usage: bench/compile-bench.sh [rounds]        (default 10)
set -uo pipefail
cd "$(dirname "$0")/.."

ROUNDS="${1:-10}"
TARGET="src/switch.rs"
MARKER="// BENCH_EDIT_MARKER"

have_blaze=0
command -v blaze >/dev/null 2>&1 && have_blaze=1

# The edit: bump a constant inside a function body so rustc must re-lower it.
# Appended once, then rewritten each round.
ensure_marker() {
  grep -q "$MARKER" "$TARGET" || cat >> "$TARGET" <<'EOF'

// BENCH_EDIT_MARKER — rewritten by bench/compile-bench.sh; harmless.
#[doc(hidden)]
pub fn __bench_probe() -> u64 { 0 }
EOF
}

edit() {
  local n="$1"
  python3 - "$TARGET" "$n" <<'PY'
import re, sys
path, n = sys.argv[1], sys.argv[2]
s = open(path).read()
s = re.sub(r'pub fn __bench_probe\(\) -> u64 \{ \d+ \}',
           f'pub fn __bench_probe() -> u64 {{ {n} }}', s)
open(path, 'w').write(s)
PY
}

ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }

stats() { # median min max  <- from stdin
  sort -n | awk '{a[NR]=$1} END {
    if (NR==0) { print "n/a"; exit }
    m = (NR%2) ? a[(NR+1)/2] : int((a[NR/2]+a[NR/2+1])/2)
    printf "median=%dms min=%dms max=%dms n=%d", m, a[1], a[NR], NR
  }'
}

ensure_marker
echo "== cold builds (reported separately; Blaze has no first-build shortcut) =="

cargo clean -q
t0=$(date +%s%N); cargo build -q >/dev/null 2>&1; cold_cargo=$(ms "$t0")
echo "cargo cold : ${cold_cargo}ms"

if [ "$have_blaze" = 1 ]; then
  t0=$(date +%s%N); blaze build >/dev/null 2>&1; cold_blaze=$(ms "$t0")
  echo "blaze cold : ${cold_blaze}ms"
else
  echo "blaze cold : not installed"
fi

echo
echo "== incremental: one function body edited per round, ${ROUNDS} rounds =="

cargo_times=""
blaze_times=""
for i in $(seq 1 "$ROUNDS"); do
  edit "$i"
  t0=$(date +%s%N); cargo build -q >/dev/null 2>&1; cargo_times+="$(ms "$t0")"$'\n'

  if [ "$have_blaze" = 1 ]; then
    edit "$((i + 1000))"
    t0=$(date +%s%N); blaze build >/dev/null 2>&1; blaze_times+="$(ms "$t0")"$'\n'
  fi
done

# --- check: the type-check loop, which is what an edit-compile cycle hits ---
cargo_chk=""
blaze_chk=""
for i in $(seq 1 "$ROUNDS"); do
  edit "$((i + 2000))"
  t0=$(date +%s%N); cargo check -q >/dev/null 2>&1; cargo_chk+="$(ms "$t0")"$'\n'
  if [ "$have_blaze" = 1 ]; then
    edit "$((i + 3000))"
    t0=$(date +%s%N); blaze check >/dev/null 2>&1; blaze_chk+="$(ms "$t0")"$'\n'
  fi
done

edit 0
echo -n "cargo build : "; printf '%s' "$cargo_times" | grep -v '^$' | stats; echo
if [ "$have_blaze" = 1 ]; then
  echo -n "blaze build : "; printf '%s' "$blaze_times" | grep -v '^$' | stats; echo
  cm=$(printf '%s' "$cargo_times" | grep -v '^$' | sort -n | awk '{a[NR]=$1} END {print (NR%2)?a[(NR+1)/2]:int((a[NR/2]+a[NR/2+1])/2)}')
  bm=$(printf '%s' "$blaze_times" | grep -v '^$' | sort -n | awk '{a[NR]=$1} END {print (NR%2)?a[(NR+1)/2]:int((a[NR/2]+a[NR/2+1])/2)}')
  if [ "${bm:-0}" -gt 0 ]; then
    echo
    awk -v c="$cm" -v b="$bm" 'BEGIN { printf "speedup (median cargo / median blaze): %.2fx\n", c/b }'
  fi
else
  echo "blaze build : not installed — cargo baseline only"
fi

echo
echo "== check (type-check only) =="
echo -n "cargo check : "; printf '%s' "$cargo_chk" | grep -v '^$' | stats; echo
if [ "$have_blaze" = 1 ]; then
  echo -n "blaze check : "; printf '%s' "$blaze_chk" | grep -v '^$' | stats; echo
  cc=$(printf '%s' "$cargo_chk" | grep -v '^$' | sort -n | awk '{a[NR]=$1} END {print (NR%2)?a[(NR+1)/2]:int((a[NR/2]+a[NR/2+1])/2)}')
  bc=$(printf '%s' "$blaze_chk" | grep -v '^$' | sort -n | awk '{a[NR]=$1} END {print (NR%2)?a[(NR+1)/2]:int((a[NR/2]+a[NR/2+1])/2)}')
  if [ "${bc:-0}" -gt 0 ]; then
    awk -v c="$cc" -v b="$bc" 'BEGIN { printf "speedup (median cargo / median blaze): %.2fx\n", c/b }'
  fi
fi
