#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
OUT=$(mktemp /tmp/sample-factory-test.XXXXXX)
trap 'rm -f "$OUT"' EXIT
gcc -std=c11 -DHOST_TEST -Wall -Wextra -Werror -Isrc tests/factory_test.c src/factory_state.c src/factory_reset.c src/clock.c src/led.c src/store.c src/curve.c src/poff.c src/event.c src/report.c src/remote.c src/radio.c -o "$OUT"
"$OUT"
gcc -std=c11 -DHOST_TEST -Wall -Wextra -Werror -Isrc tests/charge_test.c src/charger.c src/led.c src/clock.c src/event.c -o "$OUT"
"$OUT"

gcc -std=c11 -DHOST_TEST -DBOARD_DTR_WAKE_LEVEL=1 -Wall -Wextra -Werror -Isrc tests/radio_test.c src/radio.c -o "$OUT"
"$OUT"
