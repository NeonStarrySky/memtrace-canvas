#!/usr/bin/env bash
set -eu

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
case "${1:-}" in
  --ui)
    exec node "$root/server/server.mjs" "$@"
    ;;
  --demo)
    exec node "$root/server/server.mjs" "$@"
    ;;
  --trace)
    shift
    if [[ "${1:-}" == -- ]]; then shift; fi
    exec node "$root/server/server.mjs" --capture "$@"
    ;;
  ""|-*)
    printf '用法：%s --ui | --demo | --trace [--] 程序 [参数] | 程序 [参数]\n' "$0" >&2
    exit 1
    ;;
  *)
    exec "$@"
    ;;
esac
