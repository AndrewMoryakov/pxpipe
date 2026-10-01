@echo off
rem pxpipe service launcher (clean env, no quoting surprises).
rem Launch:  Start-Process cmd.exe -ArgumentList '/c','.\pxpipe-run.cmd' -WorkingDirectory (Get-Location)
rem          (explicit .\ also works where NoDefaultCurrentDirectoryInExePath is set)
rem Verify:  pwsh -File scripts\pxpipe-healthcheck.ps1     (exit 0 = healthy, 1 = problem)
rem Linux/macOS counterpart: ./pxpipe-run.sh

rem Correct OpenAI upstream for Codex signed in through ChatGPT.
rem /backend-api/codex/* exists ONLY on chatgpt.com; api.openai.com 404s it.
set "OPENAI_UPSTREAM=https://chatgpt.com"

rem Compression scope fallback (which model families pxpipe images) when no
rem dashboard choice is saved. Dashboard chip changes are saved to
rem %USERPROFILE%\.pxpipe\model-scope.json and OVERRIDE this until you press
rem "Reset to default" (which then falls back to exactly this set).
rem Built-in default (Fable 5, Opus 5.5, every Gemini) plus the families used
rem here: Sonnet 5.x for Claude Code and every GPT 5.6 sibling for Codex.
set "PXPIPE_MODELS=claude-fable-5,claude-opus-5-5,gemini,claude-sonnet-5,gpt-5.6"

cd /d "%~dp0"

rem bin\cli.js runs the bundled dist\, which is gitignored and NOT refreshed by
rem a pull or merge: an old build silently keeps serving old code. Rebuild from
rem the current source on every launch (about 3s). A failed build stops the
rem launch instead of starting a stale proxy. After a pull that changes
rem dependencies, run `pnpm install` first.
node scripts\build.mjs > pxpipe-build.log 2>&1
if errorlevel 1 (
  echo [pxpipe] build failed, not starting. See pxpipe-build.log
  exit /b 1
)

rem Capture stdout (startup banner + request log) and stderr (warnings, errors,
rem upstream error bodies) to files, overwritten each launch. Check the startup
rem health warning in pxpipe.log.err, or just run scripts\pxpipe-healthcheck.ps1.
node bin\cli.js > pxpipe.log 2> pxpipe.log.err
