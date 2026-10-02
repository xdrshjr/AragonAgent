# Deterministic replacement for "press Shift+Tab and spin the wheel by hand".
#
# Runs in its OWN console window, starts `probe-stdin.mjs` as a child that shares
# that console, then pushes synthetic INPUT_RECORDs into the shared console input
# buffer with WriteConsoleInput. What Node hands back to the probe is therefore
# exactly what libuv's Windows console-input translation produces for those key
# and mouse events - no human timing, no "did I really press Shift".
#
# Also samples GetConsoleMode(stdin) before / during / after, because whether
# ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) is set while the app is in raw mode is
# the single bit that decides if the console emits VT sequences (CSI Z, SGR mouse
# reports) at all.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File inject-console-input.ps1

param(
  [string]$NodeExe = 'node',
  [string]$Tag = 'default'
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
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetConsoleMode(IntPtr hHandle, out uint lpMode);
  [DllImport("kernel32.dll", SetLastError=true, EntryPoint="WriteConsoleInputW")]
  public static extern bool WriteConsoleInput(IntPtr hHandle, byte[] lpBuffer, uint nLength, out uint written);
}
'@
Add-Type -TypeDefinition $source

$STD_INPUT = -10
$hIn = [Con]::GetStdHandle($STD_INPUT)
$logFile = "inject-log-$Tag.txt"

function Get-Mode {
  $m = 0
  [void][Con]::GetConsoleMode($hIn, [ref]$m)
  return $m
}

# INPUT_RECORD is 20 bytes on x86 and x64 alike: WORD EventType, 2 bytes pad,
# then the 16-byte union.
function New-KeyRecord([bool]$down, [uint16]$vk, [uint16]$scan, [uint16]$ch, [uint32]$ctrl) {
  $b = New-Object byte[] 20
  [BitConverter]::GetBytes([uint16]1).CopyTo($b, 0)                      # KEY_EVENT
  [BitConverter]::GetBytes([int32]$(if ($down) { 1 } else { 0 })).CopyTo($b, 4)   # bKeyDown
  [BitConverter]::GetBytes([uint16]1).CopyTo($b, 8)                      # wRepeatCount
  [BitConverter]::GetBytes($vk).CopyTo($b, 10)                           # wVirtualKeyCode
  [BitConverter]::GetBytes($scan).CopyTo($b, 12)                         # wVirtualScanCode
  [BitConverter]::GetBytes($ch).CopyTo($b, 14)                           # uChar.UnicodeChar
  [BitConverter]::GetBytes($ctrl).CopyTo($b, 16)                         # dwControlKeyState
  return $b
}

function New-WheelRecord([int16]$x, [int16]$y, [uint32]$buttonState) {
  $b = New-Object byte[] 20
  [BitConverter]::GetBytes([uint16]2).CopyTo($b, 0)                      # MOUSE_EVENT
  [BitConverter]::GetBytes($x).CopyTo($b, 4)
  [BitConverter]::GetBytes($y).CopyTo($b, 6)
  [BitConverter]::GetBytes($buttonState).CopyTo($b, 8)                   # dwButtonState
  [BitConverter]::GetBytes([uint32]0).CopyTo($b, 12)                     # dwControlKeyState
  [BitConverter]::GetBytes([uint32]4).CopyTo($b, 16)                     # MOUSE_WHEELED
  return $b
}

# $records must be passed as a real jagged array; nLength is derived from the
# byte length, never from `.Count` - PowerShell unwraps a one-element array and
# `.Count` then reports 20 (the byte length), which makes WriteConsoleInput read
# 400 bytes out of a 20-byte buffer.
function Send-Records([byte[][]]$records, [string]$label) {
  $count = $records.Count
  $flat = New-Object byte[] (20 * $count)
  for ($i = 0; $i -lt $count; $i++) { $records[$i].CopyTo($flat, 20 * $i) }
  $written = 0
  $ok = [Con]::WriteConsoleInput($hIn, $flat, [uint32]($flat.Length / 20), [ref]$written)
  "inject $label ok=$ok written=$written" | Out-File -Append -Encoding utf8 $logFile
  Start-Sleep -Milliseconds 220
}

$SHIFT = [uint32]0x0010
$VK_TAB = [uint16]0x09
$VK_UP  = [uint16]0x26
$VK_A   = [uint16]0x41

$outFile = "probe-out-$Tag.jsonl"
Remove-Item -Force -ErrorAction SilentlyContinue $outFile, $logFile

"node_exe=$NodeExe" | Out-File -Append -Encoding utf8 $logFile
"mode_before=0x{0:X4}" -f (Get-Mode) | Out-File -Append -Encoding utf8 $logFile

$p = Start-Process -FilePath $NodeExe -ArgumentList 'probe-stdin.mjs', '9', $outFile `
                   -NoNewWindow -PassThru
Start-Sleep -Milliseconds 1500
$during = Get-Mode
"mode_during_rawmode=0x{0:X4}" -f $during | Out-File -Append -Encoding utf8 $logFile
("ENABLE_VIRTUAL_TERMINAL_INPUT during raw mode: {0}" -f (($during -band 0x0200) -ne 0)) |
  Out-File -Append -Encoding utf8 $logFile

# 'a' first: proves the injection channel itself works before anything is claimed
# about the interesting keys.
Send-Records @((New-KeyRecord $true  $VK_A  0x1E 0x0061 0),
               (New-KeyRecord $false $VK_A  0x1E 0x0061 0)) 'a'

Send-Records @((New-KeyRecord $true  $VK_TAB 0x0F 0x0009 0),
               (New-KeyRecord $false $VK_TAB 0x0F 0x0009 0)) 'Tab'

Send-Records @((New-KeyRecord $true  $VK_TAB 0x0F 0x0009 $SHIFT),
               (New-KeyRecord $false $VK_TAB 0x0F 0x0009 $SHIFT)) 'Shift+Tab'

Send-Records @((New-KeyRecord $true  $VK_UP 0x48 0x0000 0),
               (New-KeyRecord $false $VK_UP 0x48 0x0000 0)) 'Up'

Send-Records @((New-KeyRecord $true  $VK_UP 0x48 0x0000 $SHIFT),
               (New-KeyRecord $false $VK_UP 0x48 0x0000 $SHIFT)) 'Shift+Up'

# WHEEL_DELTA (120) in the high word = one notch away from the user (scroll up).
# Decimal literals: PowerShell parses 0xFF880000 as a SIGNED Int32 and the
# [uint32] parameter cast then throws.
Send-Records (,(New-WheelRecord 10 5 ([uint32]7864320)))    'WheelUp'
Send-Records (,(New-WheelRecord 10 5 ([uint32]4286578688))) 'WheelDown'

$p.WaitForExit()
"mode_after=0x{0:X4}" -f (Get-Mode) | Out-File -Append -Encoding utf8 $logFile
"done" | Out-File -Append -Encoding utf8 $logFile
