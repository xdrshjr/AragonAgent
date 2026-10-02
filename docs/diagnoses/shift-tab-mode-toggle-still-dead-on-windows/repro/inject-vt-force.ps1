# Round-2 experiment (F2 feasibility).
#
# Question round 1 left open: on a Node whose setRawMode() uses UV_TTY_MODE_RAW
# (no ENABLE_VIRTUAL_TERMINAL_INPUT), can a SECOND process turn that bit on for
# the shared console input buffer and make Shift+Tab start arriving as CSI Z --
# and does libuv clobber it again on the next raw-mode transition?
#
# Timeline (probe runs 9s, toggles raw mode at 5.0s):
#   1.5s  sample mode            -> baseline
#   1.7s  inject Shift+Tab       -> expect 09 on old Node
#   2.3s  FORCE VT INPUT ON      -> the intervention
#   2.6s  inject Shift+Tab       -> DECISIVE: 1b5b5a or 09?
#   3.2s  inject WheelUp/Down    -> does the wheel come alive too?
#   5.0s  probe toggles raw off/on
#   5.6s  sample mode            -> did libuv clear our bit?
#   5.9s  inject Shift+Tab       -> durability
param(
  [string]$NodeExe = 'node',
  [string]$Tag = 'vtforce'
)

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

$STD_INPUT = -10
$hIn = [Con2]::GetStdHandle($STD_INPUT)
$logFile = "inject-log-$Tag.txt"
$outFile = "probe-out-$Tag.jsonl"
Remove-Item -Force -ErrorAction SilentlyContinue $outFile, $logFile

$script:t0 = Get-Date
function Note([string]$m) {
  $ms = [int]((Get-Date) - $script:t0).TotalMilliseconds
  "[{0,5}ms] {1}" -f $ms, $m | Out-File -Append -Encoding utf8 $logFile
}
function Get-Mode { $m = 0; [void][Con2]::GetConsoleMode($hIn, [ref]$m); return $m }
function Note-Mode([string]$label) {
  $m = Get-Mode
  Note ("{0} mode=0x{1:X4} VT_INPUT={2} WINDOW_INPUT={3} MOUSE_INPUT={4}" -f `
        $label, $m, (($m -band 0x0200) -ne 0), (($m -band 0x0008) -ne 0), (($m -band 0x0010) -ne 0))
  return $m
}

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
function New-WheelRecord([int16]$x, [int16]$y, [uint32]$buttonState) {
  $b = New-Object byte[] 20
  [BitConverter]::GetBytes([uint16]2).CopyTo($b, 0)
  [BitConverter]::GetBytes($x).CopyTo($b, 4)
  [BitConverter]::GetBytes($y).CopyTo($b, 6)
  [BitConverter]::GetBytes($buttonState).CopyTo($b, 8)
  [BitConverter]::GetBytes([uint32]0).CopyTo($b, 12)
  [BitConverter]::GetBytes([uint32]4).CopyTo($b, 16)
  return $b
}
function Send-Records([byte[][]]$records, [string]$label) {
  $count = $records.Count
  $flat = New-Object byte[] (20 * $count)
  for ($i = 0; $i -lt $count; $i++) { $records[$i].CopyTo($flat, 20 * $i) }
  $written = 0
  $ok = [Con2]::WriteConsoleInput($hIn, $flat, [uint32]($flat.Length / 20), [ref]$written)
  Note "inject $label ok=$ok written=$written"
}

$SHIFT = [uint32]0x0010
$VK_TAB = [uint16]0x09

Note "node_exe=$NodeExe"
Note-Mode 'before_probe' | Out-Null

$p = Start-Process -FilePath $NodeExe -ArgumentList 'probe-vt.mjs', '9', $outFile, '5' `
                   -NoNewWindow -PassThru

Start-Sleep -Milliseconds 1500
$during = Note-Mode 'during_rawmode'

Send-Records @((New-KeyRecord $true  $VK_TAB 0x0F 0x0009 $SHIFT),
               (New-KeyRecord $false $VK_TAB 0x0F 0x0009 $SHIFT)) 'Shift+Tab#1_baseline'

Start-Sleep -Milliseconds 600
$forced = $during -bor 0x0200
$okSet = [Con2]::SetConsoleMode($hIn, $forced)
Note ("FORCE SetConsoleMode(0x{0:X4}) ok={1} lastErr={2}" -f $forced, $okSet, [Runtime.InteropServices.Marshal]::GetLastWin32Error())
Note-Mode 'after_force' | Out-Null

Start-Sleep -Milliseconds 300
Send-Records @((New-KeyRecord $true  $VK_TAB 0x0F 0x0009 $SHIFT),
               (New-KeyRecord $false $VK_TAB 0x0F 0x0009 $SHIFT)) 'Shift+Tab#2_DECISIVE'

Start-Sleep -Milliseconds 600
Send-Records (,(New-WheelRecord 10 5 ([uint32]7864320)))    'WheelUp'
Start-Sleep -Milliseconds 250
Send-Records (,(New-WheelRecord 10 5 ([uint32]4286578688))) 'WheelDown'

# probe toggles raw mode at 5.0s from ITS start (~1.5s after ours + startup)
Start-Sleep -Milliseconds 2300
Note-Mode 'after_probe_rawmode_toggle' | Out-Null
Start-Sleep -Milliseconds 300
Send-Records @((New-KeyRecord $true  $VK_TAB 0x0F 0x0009 $SHIFT),
               (New-KeyRecord $false $VK_TAB 0x0F 0x0009 $SHIFT)) 'Shift+Tab#3_after_toggle'

$p.WaitForExit()
Note-Mode 'after_probe_exit' | Out-Null
Note 'done'
