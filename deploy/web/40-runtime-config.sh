#!/bin/sh
# Writes /config.js from the container environment. Unset values are left
# out, so the client falls back to build-time values or the page's own host.
#
# Reads CS_NAKAMA_* first. The unprefixed NAKAMA_* names still work, but on
# Kubernetes a Service named "nakama" makes the kubelet inject
# NAKAMA_PORT=tcp://<ip>:7350 into every pod, so unprefixed values that look
# like a service link (contain "://") are ignored.
set -eu
out=/usr/share/nginx/html/config.js
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
{
  printf 'window.__CS_CONFIG__ = {'
  sep=''
  for pair in nakamaHost:NAKAMA_HOST nakamaPort:NAKAMA_PORT nakamaSsl:NAKAMA_SSL nakamaKey:NAKAMA_SERVER_KEY; do
    key=${pair%%:*}; var=${pair#*:}
    eval "val=\${CS_$var:-}"
    if [ -z "$val" ]; then
      eval "val=\${$var:-}"
      case "$val" in *://*) val='' ;; esac
    fi
    if [ -n "$val" ]; then
      printf '%s"%s":"%s"' "$sep" "$key" "$(esc "$val")"
      sep=','
    fi
  done
  printf '};\n'
} > "$out"
echo "runtime config written to $out"
