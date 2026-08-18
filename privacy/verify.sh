#!/bin/sh
# Compare every file here with the copy inside a downloaded Crank.app.
#
# The app ships these as plain, readable JavaScript inside app.asar — nothing
# is minified or obfuscated — so the claims in the README are checkable against
# the build you are actually running, not only against this repository.
#
#   ./verify.sh /Applications/Crank.app
set -e
APP="${1:-/Applications/Crank.app}"
ASAR="$APP/Contents/Resources/app.asar"
[ -f "$ASAR" ] || { echo "No app.asar in $APP"; exit 1; }

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
npx --yes @electron/asar extract "$ASAR" "$WORK" >/dev/null

status=0
# The tests are here as evidence, not as something the app ships: run them
# with `node --test electron/` in this folder.
for file in $(cd "$HERE" && find electron figma-plugin -type f -not -name "*.test.cjs" | sort); do
  if [ ! -f "$WORK/$file" ]; then
    echo "MISSING in app: $file"
    status=1
  elif diff -q "$HERE/$file" "$WORK/$file" >/dev/null; then
    echo "same     $file"
  else
    echo "DIFFERS  $file"
    status=1
  fi
done

[ "$status" -eq 0 ] && echo "\nEverything here is byte-for-byte what that app runs."
exit "$status"
