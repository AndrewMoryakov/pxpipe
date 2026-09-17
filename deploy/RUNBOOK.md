# pxpipe — Backend Deployment

Instructions for an agent (Claude Code / Codex) bringing up a contour from scratch.
Attaching clients is a separate document: **[CLIENT.md](CLIENT.md)**.

The scripts under `deploy/` are an optional accelerator. Every step below is
executable by hand; where a script does exactly the same thing, it is named.

---

## What we are building

```
agent (Claude Code) ──► 127.0.0.1:47822 ──SSH──► gateway 127.0.0.1:47821 ──► pxpipe
  Windows machine         local port               VPS, loopback only         (docker)
                                                                                 │
                                          if the gateway IP is Cloudflare-banned │
                                          172.30.250.1:3128 ◄──SSH── egress host │
                                             (docker bridge)      (its own tinyproxy)
```

**The only port exposed on the gateway is 22.** pxpipe listens on loopback only; the
sole way in is an SSH tunnel. From this follows the single most important fact:

> **pxpipe stores no keys and no tokens.** Verified: `/opt/pxpipe/.env` contains only
> `OPENAI_UPSTREAM` and `PXPIPE_MODELS`, and there is no `sk-` anywhere. It is a
> pass-through — the client sends its own credentials and pxpipe forwards them.
>
> **Therefore attaching a client creates no state on the backend.** All it needs is a
> line in `authorized_keys` and a tunnel. There is nothing to "register".

---

## 0. What to collect from the operator

Topology only — safe to commit, no secrets. A filled-in working example:
[`contour.example.env`](contour.example.env).

| Parameter | Example | Purpose |
|---|---|---|
| `GATEWAY_SSH_HOST` / `_USER` | `185.177.219.147` / `root` | where the backend lives |
| `GATEWAY_PXPIPE_PORT` | `47821` | pxpipe loopback port **on the gateway** |
| `PXPIPE_REPO` / `PXPIPE_REF` | fork + SHA | pinned sources |
| `OPENAI_UPSTREAM` | `https://chatgpt.com` | upstream for codex |
| `PXPIPE_MODELS` | `claude-opus-5,...` | which models are proxied |
| `EGRESS_MODE` | `direct` \| `upstream-proxy` | **determined by the test in §2, never asked** |
| `EGRESS_SSH_HOST` / `_USER` / `_KEY` | `81.85.50.83` / `hopt` / … | only when `upstream-proxy` |

Secrets (SSH keys, tokens) do **not** belong here. They live in `~/.ssh` and in the
client's own environment.

### Canonical ports — do not mix these up

This is the most likely way to break a deployment:

| | Port | Where |
|---|---|---|
| pxpipe listens | **47821** | on the gateway, `127.0.0.1` |
| client listens | **47822** | on the agent machine, `127.0.0.1` |
| tunnel | `127.0.0.1:47822` → `gateway:47821` | |
| agent talks to | `http://127.0.0.1:47822` | |

Verified against the live system: `docker-proxy` holds `127.0.0.1:47821` on the
gateway; the keeper holds `127.0.0.1:47822` and `::1:47822` on the client.

---

## 1. Backend

Requires Ubuntu, root, docker with the compose plugin.

```bash
# 1.1 sources, pinned to a verified SHA
git clone https://github.com/AndrewMoryakov/pxpipe.git /opt/pxpipe
cd /opt/pxpipe && git checkout <PXPIPE_REF>

# 1.2 configuration
cat > .env <<'EOF'
OPENAI_UPSTREAM=https://chatgpt.com
PXPIPE_MODELS=claude-opus-5,claude-opus-4-8,claude-sonnet-5,claude-fable-5,gpt-5.6-terra,gpt-5.6-sol,gpt-5.6-lun
EOF

# 1.3 bring up
docker compose up -d
```

**Verification — mandatory before moving on:**

```bash
ss -lntp | grep 47821
# EXPECT: LISTEN 127.0.0.1:47821 users:(("docker-proxy",...))
# If the address is 0.0.0.0, pxpipe is exposed to the internet.
# Stop, fix the compose file, do not continue.

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:47821/v1/messages
# EXPECT: 405
```

> **405 is success, not an error.** It means "wrong method", i.e. routing and TLS are
> alive. The same signal is used as the health check everywhere below.

Script: `bootstrap-gateway.sh` performs 1.1–1.3.

---

## 2. Network: how pxpipe reaches the outside

**Test first, then decide.** Run this on the gateway itself:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 --noproxy '*' \
     https://api.anthropic.com/v1/messages
```

| Response | Meaning | Action |
|---|---|---|
| `405` | the host reaches the internet directly | `EGRESS_MODE=direct` → **§2 done, go to §3** |
| `403` | IP banned by Cloudflare | `EGRESS_MODE=upstream-proxy` → §2.1 |
| timeout | no route or no DNS | fix host networking; unrelated to pxpipe |

### 2.1 upstream-proxy mode

Requires a second host whose egress is not banned and which runs tinyproxy.

**SSH tunnel gateway → egress host**, driven by a systemd unit
(template: [`systemd/tashkent-proxy-tunnel.service.template`](systemd/tashkent-proxy-tunnel.service.template)):

```ini
[Service]
ExecStart=/usr/bin/ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes \
  -L 172.30.250.1:3128:127.0.0.1:3128 \
  -i /root/.ssh/id_ed25519_tashkent_tunnel hopt@81.85.50.83
Restart=always
RestartSec=15
```

Two things here are non-obvious and both caused outages:

> **Bind to the docker bridge address (`172.30.250.1`), never to an overlay/NetBird
> address.** The overlay address changed on its own and left the tunnel permanently
> unable to come up. `172.30.250.1` is the gateway of the `pxpipe-local` docker
> network — the address the container actually talks to.

> **`RestartSec` is not optional.** Without a delay the unit accumulated **14409**
> restarts; fail2ban on the egress host saw the storm of SSH connections and banned
> the gateway, after which the tunnel could not come up at all. The fix is on both
> sides — backoff here **and** `ignoreip` there (§2.2).

Hand the proxy to the container (`compose.override.yml`):

```yaml
services:
  pxpipe:
    environment:
      HTTP_PROXY:  http://172.30.250.1:3128
      HTTPS_PROXY: http://172.30.250.1:3128
      NO_PROXY:    localhost,127.0.0.1,172.30.250.0/24
```

**Verification:**
```bash
systemctl is-active tashkent-proxy-tunnel.service   # active
ss -lntp | grep 3128                                # LISTEN 172.30.250.1:3128 (ssh)
docker compose exec pxpipe curl -s -o /dev/null -w '%{http_code}\n' \
     --max-time 15 https://api.anthropic.com/v1/messages   # 405
```

### 2.2 On the egress host: stop fail2ban from banning the gateway

```bash
# /etc/fail2ban/jail.local
[DEFAULT]
ignoreip = 127.0.0.1/8 <GATEWAY_IP>
```
```bash
systemctl restart fail2ban
fail2ban-client status sshd      # the gateway IP must not appear in "Banned IP list"
```

### 2.3 Close loopback ports to everyone else

Listening on `127.0.0.1` does not by itself mean "unreachable": containers and overlay
interfaces can reach loopback. A guard is required
([`systemd/pxpipe-localhost-guard.service`](systemd/pxpipe-localhost-guard.service)):

```bash
iptables -t raw -I PREROUTING -d 127.0.0.0/8 ! -i lo -j DROP
for p in 33080 33081 47821; do
  iptables -I INPUT -p tcp --dport $p ! -i lo -j DROP
done
```

> **iptables rules do not survive a reboot on their own.** Install
> `netfilter-persistent` **and** a systemd unit that applies them before
> `docker.service`. This can only be confirmed by an actual reboot (§3),
> never by reading `iptables -L`.

---

## 3. Backend acceptance

Not "configured" — **verified**. Order matters: reboot first, then check.

```bash
reboot
```

Once the machine is back (allow ~60 s):

```bash
systemctl is-active tashkent-proxy-tunnel.service     # active   (if upstream-proxy)
docker ps --format '{{.Names}}\t{{.Status}}' | grep pxpipe   # Up
ss -lntp | grep -E '47821|3128'                       # both listening, 47821 on 127.0.0.1
iptables -S | grep -c 'dport 4782'                    # > 0  ← rules survived the reboot
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:47821/v1/messages   # 405
```

Script: `verify.sh` runs the same set.

All green → the backend is ready; continue with **[CLIENT.md](CLIENT.md)**.

---

## 4. Failure catalogue (by symptom)

### compose came up, but 47821 listens on `0.0.0.0`
Port mapping is missing the `127.0.0.1` prefix. Fix compose to `127.0.0.1:47821:...`.
Do not leave it: that is an open proxy on the public internet.

### the container gets 403 from api.anthropic.com
The gateway IP is Cloudflare-banned. That is §2.1, `upstream-proxy`. Do not go chasing
DNS — a 403 arrives only after a successful TLS handshake.

### the egress tunnel is "active" but the container still cannot get out
Check the **bind address**: `ss -lntp | grep 3128`. It must be `172.30.250.1` — not an
overlay address, and not `127.0.0.1` (the container cannot reach the host's loopback).

### `ssh: connect to host … Connection reset` in the unit log, restart counter climbing
fail2ban on the egress host has banned the gateway. Unban
(`fail2ban-client set sshd unbanip <IP>`), add `ignoreip` (§2.2), and confirm
`RestartSec=15` is present — otherwise it will be banned again.

### everything works after a reboot except iptables
The rules are not persisted. `netfilter-persistent save` plus a unit ordered
`Before=docker.service`. Confirm **only** by rebooting.

### a unit restart-loops and floods the journal
Check `journalctl --disk-usage`. Observed case: `xray`/`zram` died after the kernel
moved to a new version and the restart loop ate the disk. Install kernel-coupled
modules as `linux-modules-extra-$(uname -r)` and re-check after every kernel upgrade.

### 401s visible in the dashboard
Almost certainly **not** a backend problem — see the "401" section in
[CLIENT.md](CLIENT.md). pxpipe holds no credentials and cannot originate a 401.

---

## 5. What is verified and what is not

**Verified on the live `frankfurt-147` contour:**
- backend, egress via upstream-proxy, loopback guard, survival across reboot;
- the client keeper caught a real disconnect and restored the tunnel in 5 s;
- end-to-end agent request: HTTP 405 through `127.0.0.1:47822`.

**Not verified — do not treat as working:**
- **nobody has ever brought up a second contour from scratch.** The parameterisation
  layer (`contour.env` + `apply-contour.ps1`) has only been exercised with `-DryRun`.
  These instructions are the source of truth; the scripts are secondary.
- `EGRESS_MODE=direct` — that branch has never executed, since the working contour
  is banned.
- the Telegram-notifying canary is **not part of deployment**; the bot was never
  created. A running canary also generates 401 noise — see CLIENT.md.
