# Round-2 experiment E3: which alternate bindings SURVIVE libuv's lossy
# INPUT_RECORD -> ANSI translation (i.e. work with NO VT input mode at all).
# A fallback binding is only worth recommending if it is measured on the very
# path that eats Shift+Tab.
param([string]$NodeExe = 'node', [string]$Tag = 'fallback')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Con4 {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll", SetLastError=true, EntryPoint="WriteConsoleInputW")]
  public static extern bool WriteConsoleInput(IntPtr h, byte[] buf, uint n, out uint written);
}
'@
$hIn = [Con4]::GetStdHandle(-10)
$logFile = "inject-log-$Tag.txt"
$outFile = "probe-out-$Tag.jsonl"
Remove-Item -Force -ErrorAction SilentlyContinue $outFile, $logFile
$script:t0 = Get-Date
function Note([string]$m) { "[{0,5}ms] {1}" -f [int]((Get-Date)-$script:t0).TotalMilliseconds, $m | Out-File -Append -Encoding utf8 $logFile }
function New-KeyRecord([bool]$down,[uint16]$vk,[uint16]$scan,[uint16]$ch,[uint32]$ctrl) {
  $b = New-Object byte[] 20
  [BitConverter]::GetBytes([uint16]1).CopyTo($b,0)
  [BitConverter]::GetBytes([int32]$(if($down){1}else{0})).CopyTo($b,4)
  [BitConverter]::GetBytes([uint16]1).CopyTo($b,8)
  [BitConverter]::GetBytes($vk).CopyTo($b,10)
  [BitConverter]::GetBytes($scan).CopyTo($b,12)
  [BitConverter]::GetBytes($ch).CopyTo($b,14)
  [BitConverter]::GetBytes($ctrl).CopyTo($b,16)
  return $b
}
function Send-Pair([uint16]$vk,[uint16]$scan,[uint16]$ch,[uint32]$ctrl,[string]$label) {
  $recs = @((New-KeyRecord $true $vk $scan $ch $ctrl),(New-KeyRecord $false $vk $scan $ch $ctrl))
  $flat = New-Object byte[] 40
  $recs[0].CopyTo($flat,0); $recs[1].CopyTo($flat,20)
  $w=0; $ok=[Con4]::WriteConsoleInput($hIn,$flat,2,[ref]$w)
  Note "inject $label ok=$ok written=$w"
  Start-Sleep -Milliseconds 320
}

$LCTRL = [uint32]0x0008
$LALT  = [uint32]0x0002
$SHIFT = [uint32]0x0010

$m=0; [void][Con4]::GetConsoleMode($hIn,[ref]$m); Note ("mode_before=0x{0:X4}" -f $m)
$p = Start-Process -FilePath $NodeExe -ArgumentList 'probe-vt.mjs','9',$outFile,'0' -NoNewWindow -PassThru
Start-Sleep -Milliseconds 1500
$m=0; [void][Con4]::GetConsoleMode($hIn,[ref]$m); Note ("mode_during=0x{0:X4} VT_INPUT={1}" -f $m, (($m -band 0x0200) -ne 0))

# Control: the broken key, so this run proves it is the lossy path.
Send-Pair 0x09 0x0F 0x0009 $SHIFT   'Shift+Tab (control, expect 09)'
# Candidates.
Send-Pair 0x50 0x19 0x0010 $LCTRL   'Ctrl+P (expect 10)'
Send-Pair 0x42 0x30 0x0002 $LCTRL   'Ctrl+B (expect 02)'
Send-Pair 0x4D 0x32 0x0000 $LALT    'Alt+M  (expect 1b 6d?)'
Send-Pair 0x71 0x3C 0x0000 0        'F2     (expect fn-key table)'
Send-Pair 0x09 0x0F 0x0009 $LCTRL   'Ctrl+Tab (expect 09?)'

$p.WaitForExit()
$m=0; [void][Con4]::GetConsoleMode($hIn,[ref]$m); Note ("mode_after=0x{0:X4}" -f $m)
Note 'done'
