#!/bin/zsh

set -e

ui_sync_dir="${0:A:h}"
cd "$ui_sync_dir"

if [[ ! -d node_modules ]]; then
  npm install
fi

npm start
