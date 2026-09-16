$ErrorActionPreference = 'Stop'

function Test-LocalPort {
    param([int]$Port)
    return [bool](Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' `
        -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Start-SshTunnel {
    param(
        [int]$LocalPort,
        [string]$Destination,
        [string]$RemoteEndpoint,
        [string]$IdentityFile = ''
    )

    if (Test-LocalPort -Port $LocalPort) {
        return
    }

    $arguments = @(
        '-N', '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-L', "127.0.0.1:${LocalPort}:${RemoteEndpoint}"
    )

    if ($IdentityFile) {
        $arguments += @('-i', $IdentityFile)
    }

    $arguments += $Destination
    Start-Process -FilePath "$env:WINDIR\System32\OpenSSH\ssh.exe" `
        -ArgumentList $arguments -WindowStyle Hidden
}

while ($true) {
    Start-SshTunnel -LocalPort 19443 -Destination 'TashkentWork' `
        -RemoteEndpoint '127.0.0.1:8443'


    Start-Sleep -Seconds 30
}