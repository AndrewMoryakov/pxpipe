# Known open defects

Referenced by `verify.ps1`. These are observed, reproduced issues that are
**not** fixed -- only contained. Acceptance checks can pass while every item
below is still true. Do not treat a green `verify` run as evidence that these
are resolved.

## Client (.147 workstation)

**Modern Standby drops the SSH tunnel.** The machine enters Modern Standby
(`Kernel-Power 506/507`), the tunnel dies, and nothing reconnects on its own.
Contained, not fixed: the keeper in `windows/pxpipe-tunnel.ps1` probes the
channel and restarts it, and a scheduled task restarts the keeper at boot and
on a 5-minute repetition. A drop is still a drop -- in-flight agent requests
fail and are retried, they are not made seamless.

**Scheduler runs Windows PowerShell 5.1, not pwsh 7.** PS 5.1 reads BOM-less
UTF-8 as ANSI. Every `.ps1` here contains Russian log strings, so a BOM-less
file gets mangled into a parse error *only under the scheduler* -- it runs fine
when launched by hand under pwsh. All shipped scripts are UTF-8 **with** BOM.
If you edit one with a tool that strips the BOM, the task breaks silently and
the failure does not reproduce in manual testing. Check:
`[IO.File]::ReadAllBytes('file.ps1')[0..2]` must be `239 187 191`.

## Gateway / dashboard

**401 entries in the dashboard request log are expected.** A model that is not
listed in `PXPIPE_MODELS` is rejected with 401 and logged as
`skip(unsupported_model)`. This is the filter working, not an auth failure.
Auth failures and model-filter rejections are currently indistinguishable in
the log view; judge by whether a model name is present in the row.

## Egress host (Tashkent)

**`systemd-zram-setup@zram0.service` fails on boot.** The zram module is absent
from kernel `6.8.0-139` because `linux-modules-extra` is not installed. Swap is
served by a swapfile instead, so this is cosmetic -- but it makes
`systemctl --failed` permanently non-empty, which hides real failures. Either
install the modules package or mask the unit; do not ignore a dirty
`--failed` list.

**`Lifebook-api.service` was a crash-loop.** It restarted continuously and
wrote ~106k journal records/day, drowning the journal and making historical
diagnosis of anything else impractical. Currently disabled. If it is
re-enabled, fix the restart loop first.

**fail2ban has banned the client before.** An August outage traced to fail2ban
banning the workstation's IP after repeated SSH failures. `ignoreip` now covers
it. A tunnel that fails *every* reconnect -- rather than intermittently -- is
the signature; check `fail2ban-client status sshd` before re-debugging the
tunnel.

## Scope note

`verify.sh` / `verify.ps1` check that the path is up **right now**. They do not
check stability over time, and they do not detect any of the above. The canary
(`windows/canary.ps1`) is what covers the time dimension.
