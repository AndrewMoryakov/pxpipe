# Attaching a Client (Agent) to pxpipe

Instructions for an agent attaching **one machine** to an already-running backend.
Repeat once per client. You do **not** need to read [RUNBOOK.md](RUNBOOK.md) for this —
everything required is here.

Target platform is Windows. The scripts in `deploy/windows/` are optional: every step
is executable by hand.

To get those scripts, clone the branch that carries them — the fork's default branch
has no `deploy/` directory:

```bash
git clone -b deploy/gateway-working-20260916 \
    https://github.com/AndrewMoryakov/pxpipe.git
```

Copy them out of the clone rather than downloading them individually: they must keep
their UTF-8 **BOM** (see Step 3), and single-file downloads routinely strip it.

---

## What you need up front

| Needed | Example |
|---|---|
| gateway host and user | `185.177.219.147`, `root` |
| pxpipe port **on the gateway** | `47821` |
| local port **on this machine** | `47822` |
| SSH key for this machine | `~/.ssh/id_ed25519_hopt` |

```
agent ──► http://127.0.0.1:47822 ──SSH──► gateway 127.0.0.1:47821
```

> **Do not confuse 47821 and 47822.** 47821 lives on the server, 47822 lives here.
> The tunnel is `-L 127.0.0.1:47822:127.0.0.1:47821`. Swapping them is the most common
> way to break the setup, and the symptom is just "nothing responds".

> **Nothing needs to be registered on the backend.** pxpipe stores no keys or tokens —
> it is a pass-through and the client sends its own credentials. The only server-side
> requirement is a public key in `authorized_keys`.

---

## Step 1. Enable the Task Scheduler log — before anything else

```powershell
wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true
```

> This log is **disabled by default**. Without it, the state "the task exists, reads as
> Ready, and has never actually run" is undiagnosable — the system keeps no trace of it
> at all. This is an installation prerequisite, not a debugging technique. Several days
> were lost to exactly this.

Check: `wevtutil gl Microsoft-Windows-TaskScheduler/Operational | Select-String enabled`
→ `enabled: true`.

---

## Step 2. SSH access

```powershell
# if no key exists yet
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\id_ed25519_hopt -N '""'
```

Install the public half into `~/.ssh/authorized_keys` of the target user on the gateway.

**Verification (mandatory — otherwise everything downstream fails silently):**
```powershell
ssh -o BatchMode=yes -o ConnectTimeout=10 -i $env:USERPROFILE\.ssh\id_ed25519_hopt root@185.177.219.147 'echo OK'
# EXPECT: OK, with no password prompt whatsoever
```
`BatchMode=yes` matters here: it turns "would prompt for a password" into an honest
error. A scheduled task can never answer a prompt.

---

## Step 3. The tunnel, supervised by a keeper

A bare `ssh -L` is not sufficient: it dies silently and never comes back (see
"Modern Standby" below). What is needed is a keeper — a loop that holds `ssh`, probes
the port, and restarts with backoff.

Ready-made: [`windows/pxpipe-tunnel.ps1`](windows/pxpipe-tunnel.ps1) → place in
`%USERPROFILE%\bin\`.

What it does:
- runs `ssh -N -L 127.0.0.1:47822:127.0.0.1:47821 root@<gateway>`;
- probes the port every 30 s; restarts after 3 consecutive failures;
- backoff 5 s → 300 s, reset after 120 s of stable operation;
- kills an orphaned `ssh` left by a previous run (otherwise it squats on 47822 and the
  new one cannot bind);
- writes `C:\ProgramData\pxpipe\pxpipe-tunnel.log`.

> **The file must be UTF-8 **with BOM**.** Task Scheduler launches tasks through
> **Windows PowerShell 5.1**, not pwsh 7. PS 5.1 reads BOM-less UTF-8 as ANSI and dies
> with `ParserError` on the first non-ASCII character. The same file runs fine under
> pwsh 7 — which is why the bug is invisible during manual testing.
> Enforced in the repo via `.gitattributes`; when copying by hand, check it yourself.
> Note the check itself is version-dependent — `-AsByteStream` is PowerShell 6+, and
> under the 5.1 this section is about you need `-Encoding Byte`:
>
> ```powershell
> # works on both:
> [IO.File]::ReadAllBytes('file.ps1')[0..2]      # EXPECT: 239 187 191
> ```

---

## Step 4. Autostart

```powershell
$act = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%USERPROFILE%\bin\pxpipe-tunnel.ps1"'

$trg = @(
  New-ScheduledTaskTrigger -AtStartup
  New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
)

$set = New-ScheduledTaskSettingsSet `
  -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$set.DisallowStartIfOnBatteries = $false
$set.StopIfGoingOnBatteries     = $false
$set.RunOnlyIfNetworkAvailable  = $false

Register-ScheduledTask -TaskName 'pxpipe-tunnel' -Action $act -Trigger $trg `
  -Settings $set -LogonType S4U -RunLevel Limited -Force
```

Every flag closes a specific observed failure:

| Flag | Without it |
|---|---|
| `DisallowStartIfOnBatteries = $false` | on a laptop the task **never starts at all** — the default is `true` |
| `StopIfGoingOnBatteries = $false` | works until the power cable is pulled |
| `ExecutionTimeLimit = PT0S` | the scheduler kills the keeper after 3 days (72 h default) |
| `RunOnlyIfNetworkAvailable = $false` | after sleep the network is "not ready yet" → run skipped |
| `StartWhenAvailable` | a run missed due to sleep is never caught up |
| `AtStartup` **and** `AtLogOn` | cover reboot and re-login; neither alone covers both |
| `S4U` | otherwise the task requires a stored password |

> **`MultipleInstances = IgnoreNew` is a deliberate trade-off.** It prevents keeper
> copies from stacking, but if the single instance ever wedges, no new one starts and
> there is no recovery. Liveness is delegated to the keeper's internal loop rather than
> to the scheduler. If the keeper ever begins to hang, this is the decision to revisit.

Script: `windows/register-tasks.ps1` registers the same thing and verifies the applied
flags by reading the task XML (`MultipleInstancesPolicy` cannot be read reliably any
other way).

---

## Step 5. Point the agent at the tunnel

`ANTHROPIC_BASE_URL` is **not** set globally. Claude Code reads it from
`~/.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:47822" } }
```

Toggle: [`windows/claude-pxpipe.ps1`](windows/claude-pxpipe.ps1) flips that key
(`on` / `off`).

> The value is applied **at startup**. A session that is already running keeps using the
> old route — restart the agent after toggling.

Codex reads `OPENAI_API_BASE` from the process environment.

---

## Step 6. Acceptance

```powershell
# 1. the tunnel is listening
Get-NetTCPConnection -State Listen -LocalPort 47822
# EXPECT: entries for both 127.0.0.1 and ::1

# 2. end-to-end request
try { Invoke-WebRequest 'http://127.0.0.1:47822/v1/messages' -Method GET -TimeoutSec 10 -UseBasicParsing }
catch { [int]$_.Exception.Response.StatusCode }
# EXPECT: 405   ← this is success: route alive, "wrong method"

# 3. the task is alive
Get-ScheduledTask -TaskName 'pxpipe-tunnel' | Get-ScheduledTaskInfo
```

**On `LastTaskResult`.** Measured on the live client while `State = Running`:

```
pxpipe-tunnel    State=Running  rc=2147946720 (0x800710E0)
```

`0x800710E0` is "the operator or administrator has refused the request" — and it is
**normal here**. It is the direct consequence of `MultipleInstances = IgnoreNew` from
Step 4: the repetition trigger fires, one instance is already running, the new one is
refused, and that refusal is what gets recorded. Judge health by `State`, by the port,
and by the log — **not** by `LastTaskResult`.

(`267009` / `0x41301` = `SCHED_S_TASK_RUNNING` is also a legitimate "still running"
code, but this configuration does not produce it. Do not go debugging `0x800710E0`.)

**Real acceptance is a reboot.** Restart, wait ~2 min, check item 1 *without logging in*,
then repeat 1–3. The `verify.ps1` script runs the same set.

---

## Failure catalogue (by symptom)

### Task reads "Ready", `LastRunTime` never changes, no trace anywhere
Enable the Task Scheduler log (Step 1) — without it the cause is invisible. Then check
`DisallowStartIfOnBatteries`: on a laptop the default `true` silently blocks startup.

### Task starts and immediately exits with a non-zero result
Open the `.ps1` and check for a BOM (Step 3). Deceptive symptom: the file runs fine when
launched manually via `pwsh`, while the scheduler uses PS 5.1 and dies on non-ASCII text.

### The tunnel ran for hours, then vanished and never returned
Modern Standby. Windows suspends the machine, tears down TCP, and does **not** restore
the forward; `ssh` may even survive as a process while serving nothing. This is the whole
reason the keeper exists. In the log it looks like this — **quoted verbatim; the keeper
currently logs in Russian**, so these are the exact strings to grep for:

```
2026-09-17T08:01:39 health: проверка не прошла (1/2)
2026-09-17T08:01:39 ssh: client_loop: send disconnect: Connection reset
2026-09-17T08:01:40 tunnel exited after 3899s, retry in 5s
2026-09-17T08:01:45 starting tunnel
2026-09-17T08:06:50 alive (туннель держится 5 мин)
```

Glossed: *probe failed (1/2)* → connection reset → *tunnel exited after 3899s, retry in
5s* → *starting tunnel* → *alive (tunnel up 5 min)*.

That is **healthy** behaviour: the break was caught and closed in 5 seconds. The alarming
case is `tunnel exited` with no following `starting tunnel`.

Other strings the keeper emits in Russian: `cleanup: убираю осиротевший ssh pid …`
(orphan cleanup, see below), `health: канал восстановился после N неудач` (recovered),
`health: канал мёртв при живом ssh - перезапускаю` (port dead while ssh alive).

### Port 47822 is occupied but requests do not go through
An orphaned `ssh` from a previous keeper. `Get-Process ssh` → kill → the keeper will
re-establish. A healthy keeper does this itself on startup.

### The agent ignores the proxy even though the tunnel is up
`ANTHROPIC_BASE_URL` is read at startup. Restart Claude Code. Confirm you edited
`~/.claude/settings.json` and not an environment variable.

---

## About the 401s in the dashboard

Observed: 4 of 19 requests returning 401. Investigated — the backend is not involved.
**pxpipe stores no credentials and cannot originate a 401**; a 401 always comes from
upstream. Over 48 h the log contains two distinct classes:

| Class | Count | What it is |
|---|---|---|
| `401 … skip(unsupported_model)` | 118 | **the canary.** It sends `claude-haiku-4-5`, which is absent from `PXPIPE_MODELS`, so pxpipe passes the request straight through and upstream rejects it. Noise, exactly every 5 minutes. |
| `401 … compressed …` | 13 | **real agent requests** with invalid credentials. Coincided with an interrupted `/login`. |

What to do:
- an even 5-minute interval → it is the canary; nothing to fix. Either add its model to
  `PXPIPE_MODELS` or stop counting those lines as incidents.
- 401 on large requests (`compressed`, tens of thousands of characters) → re-login the agent.
- 401 on **every** request → only then look at the backend and egress.

> The canary is not part of deployment (the Telegram bot was never created), and it
> generates the bulk of the 401 noise by itself. Do not install it on a new contour.
