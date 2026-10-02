# Second half of the probe: the wheel, isolated, with the one bit under test
# flipped back on halfway through.
#
# Phase A injects a wheel notch with the console input mode exactly as libuv left
# it after `setRawMode(true)`. Phase B re-enables ENABLE_MOUSE_INPUT (0x0010) and
# injects the same notch again. If A produces nothing and B produces an SGR
# report, the cleared flag IS the cause and nothing else has to be argued.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File inject-wheel-only.ps1

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$source = @'
using System;
using System.Runtime.InteropServices;
public static class Con2 {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetConsoleMode(IntPtr hHandle, out uint lpMode);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetConsoleMode(IntPtr hHandle, uint dwMode);
  [DllImport("kernel32.dll", SetLastError=true, EntryPoint="WriteConsoleInputW")]
  public static extern bool WriteConsoleInput(IntPtr hHandle, byte[] lpBuffer, uint nLength, out uint written);
}
'@
Add-Type -TypeDefinition $source

$hIn  = [Con2]::GetStdHandle(-10)
$hOut = [Con2]::GetStdHandle(-11)
$log  = 'wheel-log.txt'

function Get-Mode([IntPtr]$h) { $m = 0; [void][Con2]::GetConsoleMode($h, [ref]$m); return $m }
function Note([string]$s) { $s | Out-File -Append -Encoding utf8 $log }

function New-WheelRecord([int16]$x, [int16]$y, [uint32]$buttonState) {
  $b = New-Object byte[] 20
  [BitConverter]::GetBytes([uint16]2).CopyTo($b, 0)            # MOUSE_EVENT
  [BitConverter]::GetBytes($x).CopyTo($b, 4)
  [BitConverter]::GetBytes($y).CopyTo($b, 6)
  [BitConverter]::GetBytes($buttonState).CopyTo($b, 8)         # dwButtonState (WHEEL_DELTA<<16)
  [BitConverter]::GetBytes([uint32]0).CopyTo($b, 12)
  [BitConverter]::GetBytes([uint32]4).CopyTo($b, 16)           # MOUSE_WHEELED
  return $b
}

# One record per call, and nLength is hard-coded to 1: passing $arr.Count where
# PowerShell has already unwrapped a single-element array yields 20 and reads 400
# bytes out of a 20-byte buffer.
function Send-Wheel([uint32]$buttonState, [string]$label) {
  $rec = New-WheelRecord 10 5 $buttonState
  $written = 0
  $ok = [Con2]::WriteConsoleInput($hIn, $rec, [uint32]1, [ref]$written)
  Note "inject $label ok=$ok written=$written"
  Start-Sleep -Milliseconds 400
}

Remove-Item -Force -ErrorAction SilentlyContinue probe-wheel.jsonl, $log

Note ("in_mode_before=0x{0:X4}  out_mode_before=0x{1:X4}" -f (Get-Mode $hIn), (Get-Mode $hOut))

$p = Start-Process -FilePath 'node' -ArgumentList 'probe-stdin.mjs', '12', 'probe-wheel.jsonl' `
                   -NoNewWindow -PassThru
Start-Sleep -Milliseconds 1800

$during = Get-Mode $hIn
Note ("in_mode_during=0x{0:X4}  out_mode_during=0x{1:X4}" -f $during, (Get-Mode $hOut))
Note ("ENABLE_MOUSE_INPUT set during raw mode: {0}" -f (($during -band 0x0010) -ne 0))
Note ("ENABLE_VIRTUAL_TERMINAL_INPUT set during raw mode: {0}" -f (($during -band 0x0200) -ne 0))

# PowerShell parses `0xFF880000` as a SIGNED Int32 (-7864320), and the [uint32]
# cast on the parameter then throws. Decimal literals keep it unsigned.
$WHEEL_UP   = [uint32]7864320      # 0x00780000 - (+120 << 16)
$WHEEL_DOWN = [uint32]4286578688   # 0xFF880000 - (-120 << 16)

Note '--- phase A: mode exactly as libuv left it ---'
Send-Wheel $WHEEL_UP   'WheelUp-A'
Send-Wheel $WHEEL_DOWN 'WheelDown-A'

Note '--- phase B: ENABLE_MOUSE_INPUT forced back on ---'
$forced = $during -bor 0x0010
$okSet = [Con2]::SetConsoleMode($hIn, $forced)
Note ("SetConsoleMode(0x{0:X4}) ok={1}; readback=0x{2:X4}" -f $forced, $okSet, (Get-Mode $hIn))
Send-Wheel $WHEEL_UP   'WheelUp-B'
Send-Wheel $WHEEL_DOWN 'WheelDown-B'

$p.WaitForExit()
Note ("in_mode_after=0x{0:X4}" -f (Get-Mode $hIn))
Note 'done'
