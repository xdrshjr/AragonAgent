# Deterministic key-encoding probe driver (no human hands).
#
# Opens its OWN console window (Start-Process without -NoNewWindow for the
# outer shell is arranged by the caller; this script itself runs node with
# -NoNewWindow so the probe shares this console), pushes synthetic key
# INPUT_RECORDs with WriteConsoleInput, and lets probe-keys.mjs dump what the
# terminal/libuv hand back in the currently probed mode.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File inject-keys.ps1 -Mode kitty1

param(
  [string]$NodeExe = 'node',
  [string]$Mode = 'none'
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

$STD_INPUT = -10
$hIn = [Con]::GetStdHandle($STD_INPUT)

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
  $count = $records.Count
  $flat = New-Object byte[] (20 * $count)
  for ($i = 0; $i -lt $count; $i++) { $records[$i].CopyTo($flat, 20 * $i) }
  $written = 0
  $ok = [Con]::WriteConsoleInput($hIn, $flat, [uint32]($flat.Length / 20), [ref]$written)
  Write-Output ("inject {0} ok={1}" -f $label, $ok)
  Start-Sleep -Milliseconds 260
}

$SHIFT = [uint32]0x0010
$LCTRL = [uint32]0x0008
$LALT  = [uint32]0x0002

$outFile = "probe-out-$Mode.jsonl"
Remove-Item -Force -ErrorAction SilentlyContinue $outFile, "done-$Mode.txt"

# No -RedirectStandardOutput: the mode-enable bytes must reach the TERMINAL,
# and a redirected stdout never does (the baseline run proved it).
$p = Start-Process -FilePath $NodeExe -ArgumentList 'probe-keys.mjs', $Mode, '14', $outFile `
                   -NoNewWindow -PassThru
Start-Sleep -Milliseconds 1600

# Label echo: inject the marker first so JSONL lines can be attributed.
# (The probe only logs stdin; the inject order below is the label source.)
Send-Keys 0x41 0x1E 0x0061 0            'a'
Send-Keys 0x0D 0x1C 0x000D 0            'Enter'
Send-Keys 0x0D 0x1C 0x000D $SHIFT       'Shift+Enter'
Send-Keys 0x0D 0x1C 0x000A $LCTRL       'Ctrl+Enter'
Send-Keys 0x0D 0x1C 0x000D $LALT        'Alt+Enter'
Send-Keys 0x43 0x2E 0x0003 $LCTRL       'Ctrl+C'
Send-Keys 0x41 0x1E 0x0001 $LCTRL       'Ctrl+A'
Send-Keys 0x42 0x30 0x0062 $LALT        'Alt+B'
Send-Keys 0x4A 0x24 0x000A $LCTRL       'Ctrl+J'
Send-Keys 0x1B 0x01 0x001B 0            'Esc'
Send-Keys 0x09 0x0F 0x0009 0            'Tab'
Send-Keys 0x09 0x0F 0x0009 $SHIFT       'Shift+Tab'
Send-Keys 0x26 0x48 0x0000 0            'Up'
Send-Keys 0x26 0x48 0x0000 $SHIFT       'Shift+Up'
Send-Keys 0x26 0x48 0x0000 $LCTRL       'Ctrl+Up'
Send-Keys 0x25 0x4B 0x0000 $LCTRL       'Ctrl+Left'
Send-Keys 0x21 0x49 0x0000 0            'PgUp'
Send-Keys 0x24 0x47 0x0000 0            'Home'
Send-Keys 0x23 0x4F 0x0000 0            'End'
Send-Keys 0x2E 0x53 0x0000 0            'Delete'
Send-Keys 0x08 0x0E 0x0008 0            'Backspace'

$p.WaitForExit()
Set-Content -Path "done-$Mode.txt" -Value 'done'
Write-Output "probe done mode=$Mode"
