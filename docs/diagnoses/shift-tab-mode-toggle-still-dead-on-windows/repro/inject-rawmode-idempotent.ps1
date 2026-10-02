# E4 runner. Opens nothing and injects nothing - the probe only needs to be
# attached to a real console, which is what `-File` from a console window gives
# it. See probe-rawmode-idempotent.mjs for what is being measured and why.
param([string]$NodeExe = 'node')

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir 'probe-out-rawmode-idempotent.txt'

& $NodeExe (Join-Path $dir 'probe-rawmode-idempotent.mjs') $log
$code = $LASTEXITCODE

Write-Output ''
Write-Output "probe exit code: $code"
Write-Output "log: $log"
exit $code
