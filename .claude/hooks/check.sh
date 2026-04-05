#!/usr/bin/env bash
set -euo pipefail

# Read hook input JSON from stdin, extract the edited file path
input="$(cat)"
file_path="$(jq -r '.tool_input.file_path // ""' <<<"$input")"

# Nothing to do if no file
[[ -n "$file_path" && -f "$file_path" ]] || exit 0

proj="${CLAUDE_PROJECT_DIR:-.}"
has_errors=0
err() { printf "%s\n" "$*" 1>&2; }

# Prefer local binaries over npx (faster, avoids supply-chain risk)
get_oxlint() {
  local local_bin="$proj/node_modules/.bin/oxlint"
  if [[ -x "$local_bin" ]]; then echo "$local_bin"
  else echo "npx -y oxlint"; fi
}
get_oxfmt() {
  local local_bin="$proj/node_modules/.bin/oxfmt"
  if [[ -x "$local_bin" ]]; then echo "$local_bin"
  else echo "npx -y oxfmt"; fi
}

# OXC lint + format (token-efficient: one-line hint)
case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.jsonc|*.css)
    oxlint_cmd="$(get_oxlint)"
    oxfmt_cmd="$(get_oxfmt)"
    report="$(cd "$proj" && $oxlint_cmd -f json --max-warnings=50 "$file_path" 2>/dev/null || true)"
    errors="$(jq -r '[.[] | select(.severity == "error" or .severity == "deny")] | length' <<<"$report" 2>/dev/null || echo 0)"
    if (( errors > 0 )); then
      first="$(jq -r '
        first(.[] | select(.severity == "error" or .severity == "deny")) as $d
        | [($d.code // "oxlint"), ($d.message | gsub("[\\r\\n]+"; " ") | .[0:140]), (($d.filename // "'"$file_path"'") + ":" + (($d.line // 1) | tostring))]
        | "\(.[0]) \(.[1]) @ \(.[2])"
      ' <<<"$report" 2>/dev/null || echo "oxlint error")"
      err "Hint: Oxlint found ${errors} error(s). ${first}"
      has_errors=1
    else
      cd "$proj" && $oxlint_cmd --fix "$file_path" >/dev/null 2>&1 || true
    fi
    cd "$proj" && $oxfmt_cmd "$file_path" >/dev/null 2>&1 || true
  ;;
esac

# Optional: summarize TS typecheck without blocking
case "$file_path" in
  *.ts|*.tsx)
    if command -v pnpm >/dev/null 2>&1; then
      tc_out="$(cd "$proj" && pnpm -s tsc --noEmit 2>&1 || true)"
      tc_clean="$(printf "%s" "$tc_out" | sed -E 's/\x1B\[[0-9;]*[A-Za-z]//g')"
      tc_count="$(printf "%s" "$tc_clean" | grep -E -c 'error TS[0-9]+' || true)"
      if [[ "${tc_count:-0}" -gt 0 ]]; then
        first_ts="$(printf "%s" "$tc_clean" | grep -E 'error TS[0-9]+' -m1 | sed -E 's/[[:space:]]+/ /g')"
        err "Hint: TypeScript found ${tc_count} error(s). ${first_ts}"
        has_errors=1
      fi
    fi
  ;;
esac

# Python: Ruff + BasedPyright
case "$file_path" in
  *.py)
    if command -v uv >/dev/null 2>&1; then
      if ! uv run ruff check --fix "$file_path" 2>&1; then
        err "Hint: Ruff found issues in $file_path"
        has_errors=1
      fi
      if ! uv run basedpyright "$file_path" 2>&1; then
        err "Hint: BasedPyright type checking failed for $file_path"
        has_errors=1
      fi
    fi
  ;;
esac

# Swift: SwiftFormat + SwiftLint
case "$file_path" in
  *.swift)
    if command -v swiftformat >/dev/null 2>&1; then
      if ! swiftformat "$file_path" --quiet 2>&1; then
        err "Hint: SwiftFormat failed for $file_path"
        has_errors=1
      fi
    fi
    if command -v swiftlint >/dev/null 2>&1; then
      lint_out="$(swiftlint lint --strict --quiet "$file_path" 2>&1 || true)"
      if [[ -n "$lint_out" ]]; then
        lint_count="$(printf "%s" "$lint_out" | wc -l | tr -d ' ')"
        first_lint="$(printf "%s" "$lint_out" | head -1)"
        err "Hint: SwiftLint found ${lint_count} issue(s). ${first_lint}"
        has_errors=1
      fi
    fi
  ;;
esac

# Feed hints back to Claude on PostToolUse via stderr when errors exist
if (( has_errors > 0 )); then
  exit 2
fi
exit 0
