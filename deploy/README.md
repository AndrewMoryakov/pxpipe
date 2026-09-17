# deploy/ — pxpipe contour deployment

This kit reproduces a working setup: agents (Claude Code / Codex) on user machines
reach api.anthropic.com and chatgpt.com through a self-hosted pxpipe on a VPS.
Any number of clients can attach to a single backend.

## Start here

| Task | Document |
|---|---|
| bring up the backend and its networking — **once per contour** | **[RUNBOOK.md](RUNBOOK.md)** |
| attach an agent machine — **once per client** | **[CLIENT.md](CLIENT.md)** |

Both documents are self-contained and written to be executed by an agent.
CLIENT.md does not require reading RUNBOOK.md.

**The instructions are the source of truth, not the scripts.** Every step in them is
executable by hand; the scripts below only accelerate the same work.

## Topology

```
agent ──► 127.0.0.1:47822 ──SSH──► gateway 127.0.0.1:47821 ──► pxpipe (docker)
                                                                     │
                                       if the gateway IP is banned:  │
                                       172.30.250.1:3128 ◄──SSH── egress host
```

Only port 22 is exposed on the gateway; pxpipe listens on loopback.
**pxpipe stores no keys or tokens** — it is a pass-through and the client sends its own
credentials.

## Files

| File | Purpose |
|---|---|
| `contour.example.env` | contour description; the filled-in example is the live `frankfurt-147` |
| `bootstrap-gateway.sh` | server: clone, `.env`, `docker compose up` |
| `systemd/tashkent-proxy-tunnel.service.template` | server: SSH tunnel to the egress host |
| `systemd/pxpipe-localhost-guard.{service,sh.template}` | server: iptables guard for loopback ports |
| `verify.sh` | server: acceptance checks |
| `windows/pxpipe-tunnel.ps1` | client: SSH tunnel keeper |
| `windows/register-tasks.ps1` | client: scheduled task registration |
| `windows/claude-pxpipe.ps1` | client: `ANTHROPIC_BASE_URL` toggle in settings.json |
| `windows/start-tashkent-tunnels.ps1` | client: adjacent work tunnels (not pxpipe) |
| `windows/apply-contour.ps1` | client: renders `contour.env` into the scripts — **see caveat** |
| `windows/canary.ps1` | periodic probe — **not part of deployment** |
| `verify.ps1` | client: acceptance checks |

## Caveats

All `.ps1` files are **UTF-8 with BOM**. Task Scheduler runs them through Windows
PowerShell 5.1, which without a BOM reads the file as ANSI and dies on non-ASCII
characters. Enforced by `.gitattributes`.

`contour.env` is not committed. It holds no secrets — only topology; keys live in
`~/.ssh` and agent credentials stay on the client.

## What is verified and what is not

**Verified** on the live `frankfurt-147` contour: backend, egress via upstream-proxy,
the iptables guard surviving a reboot, the keeper catching a real disconnect and
restoring the tunnel in 5 s, and an end-to-end agent request returning HTTP 405.

**Not verified:**
- nobody has brought up a second contour from scratch; `apply-contour.ps1` has only
  been run with `-DryRun`;
- the `EGRESS_MODE=direct` branch has never executed — the working contour is
  Cloudflare-banned;
- the Telegram canary: the bot was never created, and the canary itself produces most
  of the 401 noise in the dashboard (analysis in CLIENT.md).
