#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${C64_DEBUG_HTTP_URL:-http://127.0.0.1:39080/mcp}"
HEALTH_URL="${C64_DEBUG_HTTP_HEALTH_URL:-${BASE_URL%/mcp}/healthz}"
FIXTURE_PATH="${C64_DEBUG_FIXTURE_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/achtung_russia.prg}"
BREAKPOINT_ADDRESS="${C64_DEBUG_BREAKPOINT_ADDRESS:-5148}"
POLL_ATTEMPTS="${C64_DEBUG_POLL_ATTEMPTS:-30}"
POLL_SLEEP_SECONDS="${C64_DEBUG_POLL_SLEEP_SECONDS:-0.2}"

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require_bin curl
require_bin jq
require_bin file

usage() {
  cat <<'EOF'
Usage:
  bash scripts/test-live-http.sh health
  bash scripts/test-live-http.sh tools
  bash scripts/test-live-http.sh basic
  bash scripts/test-live-http.sh advanced

Environment:
  C64_DEBUG_HTTP_URL          Default: http://127.0.0.1:39080/mcp
  C64_DEBUG_HTTP_HEALTH_URL   Default: ${C64_DEBUG_HTTP_URL%/mcp}/healthz
  C64_DEBUG_FIXTURE_PATH      Default: repo-root/achtung_russia.prg
  C64_DEBUG_BREAKPOINT_ADDRESS Default: 5148 (0x141c)
EOF
}

init_session() {
  local response
  response="$(curl -i -sS -X POST "$BASE_URL" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"live-http-test","version":"1.0.0"}}}')"

  SESSION_ID="$(printf '%s' "$response" | awk 'BEGIN{IGNORECASE=1} /^mcp-session-id:/ {gsub("\r", "", $2); print $2}')"
  if [[ -z "${SESSION_ID:-}" ]]; then
    echo "failed to initialize MCP session" >&2
    printf '%s\n' "$response" >&2
    exit 1
  fi

  curl -sS -X POST "$BASE_URL" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SESSION_ID" \
    --data '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
}

call_tool() {
  local id="$1"
  local name="$2"
  local args="$3"
  curl -sS -X POST "$BASE_URL" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SESSION_ID" \
    --data "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$args}}"
}

tool_data() {
  jq '.result.structuredContent.data'
}

tool_error_text() {
  jq -r '.result.content[0].text // empty'
}

tool_is_error() {
  jq -r '.result.isError'
}

ensure_running() {
  local state
  state="$(call_tool 900 get_monitor_state '{}')"
  local execution_state
  execution_state="$(printf '%s' "$state" | jq -r '.result.structuredContent.data.executionState')"
  if [[ "$execution_state" == "running" ]]; then
    return 0
  fi
  if [[ "$execution_state" == "stopped" ]]; then
    call_tool 901 execute '{"action":"resume"}' >/dev/null
    sleep 1
  else
    sleep 1
  fi
}

wait_for_paused() {
  local paused=""
  local current=""
  for _ in $(seq 1 "$POLL_ATTEMPTS"); do
    current="$(call_tool 920 get_monitor_state '{}')"
    if [[ "$(printf '%s' "$current" | jq -r '.result.structuredContent.data.executionState')" == "stopped" ]]; then
      paused="$current"
      break
    fi
    sleep "$POLL_SLEEP_SECONDS"
  done
  if [[ -z "$paused" ]]; then
    echo "breakpoint did not pause in time" >&2
    exit 1
  fi
  printf '%s' "$paused"
}

run_health() {
  curl -i -sS "$HEALTH_URL"
}

run_tools() {
  init_session
  curl -sS -X POST "$BASE_URL" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SESSION_ID" \
    --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' |
    jq '{sessionId: "'"$SESSION_ID"'", toolNames: [.result.tools[].name]}'
}

run_basic() {
  init_session
  local state capture image_path
  state="$(call_tool 2 get_monitor_state '{}')"
  capture="$(call_tool 3 capture_display '{"useVic":true}')"
  image_path="$(printf '%s' "$capture" | jq -r '.result.structuredContent.data.imagePath')"

  jq -n \
    --arg sessionId "$SESSION_ID" \
    --arg captureFile "$(file "$image_path")" \
    --argjson state "$(printf '%s' "$state" | jq '.result.structuredContent.data')" \
    --argjson capture "$(printf '%s' "$capture" | jq '.result.structuredContent.data')" \
    '{
      sessionId: $sessionId,
      state: $state,
      capture: $capture,
      captureFile: $captureFile
    }'
}

run_advanced() {
  init_session

  local state1 capture1 image1 run_err load state2 text state3 capture2 image2 bp bp_id paused regs step mem clear resume final

  state1="$(call_tool 2 get_monitor_state '{}')"
  capture1="$(call_tool 3 capture_display '{"useVic":true}')"
  image1="$(printf '%s' "$capture1" | jq -r '.result.structuredContent.data.imagePath')"

  run_err="$(call_tool 4 get_registers '{}')"

  ensure_running
  load="$(call_tool 5 program_load "{\"filePath\":\"$FIXTURE_PATH\",\"autoStart\":false,\"fileIndex\":0}")"
  state2="$(call_tool 6 get_monitor_state '{}')"

  text="$(call_tool 7 write_text '{"text":"LIST\n"}')"
  sleep 2
  state3="$(call_tool 8 get_monitor_state '{}')"

  capture2="$(call_tool 9 capture_display '{"useVic":true}')"
  image2="$(printf '%s' "$capture2" | jq -r '.result.structuredContent.data.imagePath')"

  bp="$(call_tool 10 breakpoint_set "{\"address\":$BREAKPOINT_ADDRESS,\"kind\":\"exec\",\"length\":1,\"enabled\":true,\"label\":\"live_http_bp\"}")"
  bp_id="$(printf '%s' "$bp" | jq -r '.result.structuredContent.data.breakpoint.id')"
  paused="$(wait_for_paused)"

  regs="$(call_tool 11 get_registers '{}')"
  step="$(call_tool 12 execute '{"action":"step","count":2}')"
  mem="$(call_tool 13 memory_read '{"address":2049,"length":16}')"
  clear="$(call_tool 14 breakpoint_clear "{\"breakpointId\":$bp_id}")"
  resume="$(call_tool 15 execute '{"action":"resume"}')"
  sleep 1
  final="$(call_tool 16 get_monitor_state '{}')"

  jq -n \
    --arg sessionId "$SESSION_ID" \
    --arg capture1File "$(file "$image1")" \
    --arg capture2File "$(file "$image2")" \
    --argjson state1 "$(printf '%s' "$state1" | jq '.result.structuredContent.data')" \
    --argjson runErrIsError "$(printf '%s' "$run_err" | tool_is_error | jq -R 'if . == "true" then true else false end')" \
    --argjson load "$(printf '%s' "$load" | jq '{isError: .result.isError, data: (.result.structuredContent.data // null), errorText: (.result.content[0].text // null)}')" \
    --argjson state2 "$(printf '%s' "$state2" | jq '.result.structuredContent.data')" \
    --argjson text "$(printf '%s' "$text" | jq '.result.structuredContent.data')" \
    --argjson state3 "$(printf '%s' "$state3" | jq '.result.structuredContent.data')" \
    --argjson capture1 "$(printf '%s' "$capture1" | jq '.result.structuredContent.data')" \
    --argjson capture2 "$(printf '%s' "$capture2" | jq '.result.structuredContent.data')" \
    --argjson breakpoint "$(printf '%s' "$bp" | jq '.result.structuredContent.data.breakpoint')" \
    --argjson paused "$(printf '%s' "$paused" | jq '.result.structuredContent.data')" \
    --argjson registers "$(printf '%s' "$regs" | jq '.result.structuredContent.data.registers')" \
    --argjson step "$(printf '%s' "$step" | jq '.result.structuredContent.data')" \
    --argjson memory "$(printf '%s' "$mem" | jq '.result.structuredContent.data')" \
    --argjson clear "$(printf '%s' "$clear" | jq '.result.structuredContent.data')" \
    --argjson resume "$(printf '%s' "$resume" | jq '.result.structuredContent.data')" \
    --argjson final "$(printf '%s' "$final" | jq '.result.structuredContent.data')" \
    '{
      sessionId: $sessionId,
      initialState: $state1,
      runningGetRegistersIsError: $runErrIsError,
      load: $load,
      stateAfterLoad: $state2,
      writeText: $text,
      stateAfterText: $state3,
      capture1: $capture1,
      capture2: $capture2,
      capture1File: $capture1File,
      capture2File: $capture2File,
      breakpoint: $breakpoint,
      pausedState: $paused,
      registers: $registers,
      step: $step,
      memory: $memory,
      clear: $clear,
      resume: $resume,
      finalState: $final
    }'
}

MODE="${1:-}"
case "$MODE" in
  health) run_health ;;
  tools) run_tools ;;
  basic) run_basic ;;
  advanced) run_advanced ;;
  *) usage; exit 1 ;;
esac
