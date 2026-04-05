#!/usr/bin/env bash
# Cursor afterFileEdit hook: lint/typecheck the edited file, emit hints, never block
set -euo pipefail

# Read Cursor's JSON payload from stdin
input="$(cat)"

# Extract fields from payload
event="$(jq -r '.hook_event_name // ""' <<<"$input")"
file_path="$(jq -r '.file_path // ""' <<<"$input")"
proj="$(jq -r '.workspace_roots[0] // ""' <<<"$input")"
[[ -n "$proj" ]] || proj="$(pwd)"

# Require a file path; ignore if missing
[[ -n "$file_path" ]] || exit 0

# Normalize absolute path
if [[ "$file_path" != /* ]]; then
  abs="$proj/$file_path"
else
  abs="$file_path"
fi

# If file no longer exists, skip
[[ -f "$abs" ]] || exit 0

has_errors=0
err() { printf "%s\n" "$*" 1>&2; }

# --- OXC lint + format: JS/TS/JSON/CSS ---
case "$abs" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.jsonc|*.css)
    oxlint_bin="$proj/node_modules/.bin/oxlint"
    oxfmt_bin="$proj/node_modules/.bin/oxfmt"
    oxlint_cmd="$([[ -x "$oxlint_bin" ]] && echo "$oxlint_bin" || echo "npx -y oxlint")"
    oxfmt_cmd="$([[ -x "$oxfmt_bin" ]] && echo "$oxfmt_bin" || echo "npx -y oxfmt")"

    report="$(cd "$proj" && $oxlint_cmd -f json --max-warnings=50 "$abs" 2>/dev/null || true)"
    errors="$(jq -r '[.[] | select(.severity == "error" or .severity == "deny")] | length' <<<"$report" 2>/dev/null || echo 0)"
    if (( errors > 0 )); then
      first="$(jq -r '
        first(.[] | select(.severity == "error" or .severity == "deny")) as $d
        | [($d.code // "oxlint"), ($d.message | gsub("[\\r\\n]+"; " ") | .[0:140]), (($d.filename // "'"$abs"'") + ":" + (($d.line // 1) | tostring))]
        | "\(.[0]) \(.[1]) @ \(.[2])"
      ' <<<"$report" 2>/dev/null || echo "oxlint error")"
      err "Hint: Oxlint found ${errors} error(s). ${first}"
      has_errors=1
    else
      (cd "$proj" && $oxlint_cmd --fix "$abs" >/dev/null 2>&1 || true)
    fi
    (cd "$proj" && $oxfmt_cmd "$abs" >/dev/null 2>&1 || true)
  ;;
esac

# --- TypeScript: tsc --noEmit (non-blocking summary) ---
case "$abs" in
  *.ts|*.tsx)
    # Prefer local bin, then pnpm, then npx fallback
    ts_cmd=()
    if [[ -x "$proj/node_modules/.bin/tsc" ]]; then
      ts_cmd=("$proj/node_modules/.bin/tsc")
    elif command -v pnpm >/dev/null 2>&1; then
      ts_cmd=(pnpm -s tsc)
    elif command -v npx >/dev/null 2>&1; then
      ts_cmd=(npx -y typescript tsc)
    fi

    if (( ${#ts_cmd[@]} )); then
      tc_out="$(
        cd "$proj" && "${ts_cmd[@]}" --noEmit --pretty false ${TSC_PROJECT:+-p "$TSC_PROJECT"} 2>&1 || true
      )"
      # Count and summarize
      tc_count="$(printf "%s" "$tc_out" | grep -E -c 'error TS[0-9]+' || true)"
      if [[ "${tc_count:-0}" -gt 0 ]]; then
        first_ts="$(printf "%s" "$tc_out" | grep -E 'error TS[0-9]+' -m1 | sed -E 's/[[:space:]]+/ /g')"
        err "Hint: TypeScript found ${tc_count} error(s). ${first_ts}"
        has_errors=1
      fi
    fi
  ;;
esac

# --- Python: Ruff + BasedPyright on the single file ---
case "$abs" in
  *.py)
    if command -v uv >/dev/null 2>&1; then
      if ! uv run ruff check --fix "$abs"; then
        err "Hint: Ruff found issues in $file_path"
        has_errors=1
      fi
      if ! uv run basedpyright "$abs"; then
        err "Hint: BasedPyright type checking failed for $file_path"
        has_errors=1
      fi
    fi
  ;;
esac

# --- Swift: SwiftFormat + SwiftLint ---
case "$abs" in
  *.swift)
    if command -v swiftformat >/dev/null 2>&1; then
      if ! swiftformat "$abs" --quiet 2>&1; then
        err "Hint: SwiftFormat failed for $abs"
        has_errors=1
      fi
    fi
    if command -v swiftlint >/dev/null 2>&1; then
      lint_out="$(swiftlint lint --strict --quiet "$abs" 2>&1 || true)"
      if [[ -n "$lint_out" ]]; then
        lint_count="$(printf "%s" "$lint_out" | wc -l | tr -d ' ')"
        first_lint="$(printf "%s" "$lint_out" | head -1 | sed -E 's/[[:space:]]+/ /g')"
        err "Hint: SwiftLint found ${lint_count} issue(s). ${first_lint}"
        has_errors=1
      fi
    fi
  ;;
esac

# Do not block edits; afterFileEdit is a notification hook
# Exit 0 so the agent's apply continues regardless of findings
exit 0
