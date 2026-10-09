# E2E driver: real console -> real production filter -> what Ink receives.
# Same injection harness as inject-keys.ps1, but the probe under test is
# probe-filter-e2e.mjs (filter pipeline, not raw bytes).
param(
  [string]$NodeExe = 'node'
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$source = @'
using System;
using System.Runtime.InteropServices;
public static class Con {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", SetLastError=true, EntryPoint="WriteConsoleInputW")]
  public static extern bool WriteConsoleInput(IntPtr hHandle, byte[] lpBuffer, uint nLength, out uint written);
}
'@
Add-Type -TypeDefinition $source
$hIn = [Con]::GetStdHandle(-10)

function New-KeyRecord([bool]$down, [uint16]$vk, [uint16]$scan, [uint16]$ch, [uint32]$ctrl) {
  $b = New-Object byte[] 20
  [BitConverter]::GetBytes([uint16]1).CopyTo($b, 0)
  [BitConverter]::GetBytes([int32]$(if ($down) { 1 } else { 0 })).CopyTo($b, 4)
  [BitConverter]::GetBytes([uint16]1).CopyTo($b, 8)
  [BitConverter]::GetBytes($vk).CopyTo($b, 10)
  [BitConverter]::GetBytes($scan).CopyTo($b, 12)
  [BitConverter]::GetBytes($ch).CopyTo($b, 14)
  [BitConverter]::GetBytes($ctrl).CopyTo($b, 16)
  return $b
}

function Send-Keys([uint16]$vk, [uint16]$scan, [uint16]$ch, [uint32]$ctrl, [string]$label) {
  $records = @(
    (New-KeyRecord $true  $vk $scan $ch $ctrl),
    (New-KeyRecord $false $vk $scan $ch $ctrl)
  )
  $flat = New-Object byte[] (20 * $records.Count)
  for ($i = 0; $i -lt $records.Count; $i++) { $records[$i].CopyTo($flat, 20 * $i) }
  $written = 0
  [void][Con]::WriteConsoleInput($hIn, $flat, [uint32]2, [ref]$written)
  Write-Output ("inject {0}" -f $label)
  Start-Sleep -Milliseconds 260
}

$outFile = 'filter-e2e-out.jsonl'
Remove-Item -Force -ErrorAction SilentlyContinue $outFile, 'done-e2e.txt'

$p = Start-Process -FilePath $NodeExe -ArgumentList 'probe-filter-e2e.mjs', '12', $outFile `
                   -NoNewWindow -PassThru
Start-Sleep -Milliseconds 1600

$SHIFT = [uint32]0x0010
$LCTRL = [uint32]0x0008
$LALT  = [uint32]0x0002

Send-Keys 0x41 0x1E 0x0061 0        'a'
Send-Keys 0x0D 0x1C 0x000D 0        'Enter'
Send-Keys 0x0D 0x1C 0x000D $SHIFT   'Shift+Enter'
Send-Keys 0x43 0x2E 0x0003 $LCTRL   'Ctrl+C'
Send-Keys 0x09 0x0F 0x0009 $SHIFT   'Shift+Tab'
Send-Keys 0x26 0x48 0x0000 $SHIFT   'Shift+Up'
Send-Keys 0x1B 0x01 0x001B 0        'Esc'

$p.WaitForExit()
Set-Content -Path 'done-e2e.txt' -Value 'done'
Write-Output 'e2e probe done'
