#!/bin/sh
# Registers the native host for Firefox for the current user (or, with
# --system, for everyone: run it as root).
# Copyright (C) 2026 Grigory Tuboltsev; SPDX-License-Identifier: MIT
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = --system ]; then
    bin=/usr/lib/speechd-reader/speechd-reader-host
    dir=/usr/lib/mozilla/native-messaging-hosts
    install -D -m 755 "$here/speechd-reader-host" "$bin"
else
    bin="$here/speechd-reader-host"
    dir="${HOME}/.mozilla/native-messaging-hosts"
fi
mkdir -p "$dir"
cat > "$dir/speechd_reader.json" <<JSON
{
  "name": "speechd_reader",
  "description": "Speech Dispatcher for the Speech Dispatcher Reader extension",
  "path": "$bin",
  "type": "stdio",
  "allowed_extensions": ["speechd-reader@tuboltsev.github.io"]
}
JSON
echo "registered $dir/speechd_reader.json -> $bin"
