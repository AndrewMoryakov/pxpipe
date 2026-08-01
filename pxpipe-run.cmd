@echo off
rem pxpipe service launcher (clean env, no quoting surprises).
rem Launch:  Start-Process cmd.exe -ArgumentList '/c','pxpipe-run.cmd' -WorkingDirectory (Get-Location)
rem Verify:  pwsh -File scripts\pxpipe-healthcheck.ps1     (exit 0 = healthy, 1 = problem)

rem Correct OpenAI upstream for Codex signed in through ChatGPT.
rem /backend-api/codex/* exists ONLY on chatgpt.com; api.openai.com 404s it.
set "OPENAI_UPSTREAM=https://chatgpt.com"

rem Compression scope fallback (which model families pxpipe images) when no
rem dashboard choice is saved. Dashboard chip changes are saved to
rem %USERPROFILE%\.pxpipe\model-scope.json and OVERRIDE this until you press
rem "Reset to default" (which then falls back to exactly this set).
set "PXPIPE_MODELS=claude-opus-4-8,claude-sonnet-5,claude-fable-5,gpt-5.6-terra,gpt-5.6-sol,gpt-5.6-lun"

cd /d "%~dp0"

rem Capture stdout (startup banner + request log) and stderr (warnings, errors,
rem upstream error bodies) to files, overwritten each launch. Check the startup
rem health warning in pxpipe.log.err, or just run scripts\pxpipe-healthcheck.ps1.
node bin\cli.js > pxpipe.log 2> pxpipe.log.err
