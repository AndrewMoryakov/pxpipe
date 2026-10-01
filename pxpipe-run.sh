#!/usr/bin/env sh
# pxpipe service launcher for Linux/macOS — counterpart of pxpipe-run.cmd.
# Launch:  ./pxpipe-run.sh            (foreground; Ctrl+C stops it)
#          nohup ./pxpipe-run.sh &    (background)
# Verify:  ./scripts/pxpipe-healthcheck.sh   (exit 0 = healthy, 1 = problem)
set -eu

# Correct OpenAI upstream for Codex signed in through ChatGPT.
# /backend-api/codex/* exists ONLY on chatgpt.com; api.openai.com 404s it.
export OPENAI_UPSTREAM="${OPENAI_UPSTREAM:-https://chatgpt.com}"

# Compression scope fallback when no dashboard choice is saved. Dashboard chip
# changes are saved to ~/.pxpipe/model-scope.json and OVERRIDE this until you
# press "Reset to default". Built-in default (Fable 5, Opus 5.5, every Gemini)
# plus Sonnet 5.x for Claude Code and every GPT 5.6 sibling for Codex.
export PXPIPE_MODELS="${PXPIPE_MODELS:-claude-fable-5,claude-opus-5-5,gemini,claude-sonnet-5,gpt-5.6}"

cd "$(dirname "$0")"

# bin/cli.js runs the bundled dist/, which is gitignored and NOT refreshed by a
# pull or merge. Rebuild from the current source on every launch (a few
# seconds); a failed build stops the launch instead of starting a stale proxy.
# After a pull that changes dependencies, run `pnpm install` first.
if ! node scripts/build.mjs > pxpipe-build.log 2>&1; then
  echo "[pxpipe] build failed, not starting. See pxpipe-build.log" >&2
  exit 1
fi

# stdout = startup banner + request log, stderr = warnings and upstream error
# bodies; both overwritten each launch.
exec node bin/cli.js > pxpipe.log 2> pxpipe.log.err
