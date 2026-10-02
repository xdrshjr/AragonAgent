param([string]$NodeExe = 'node', [string]$Tag = 'e2')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Con3 {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll", SetLastError=true, EntryPoint="WriteConsoleInputW")]
  public static extern bool WriteConsoleInput(IntPtr h, byte[] buf, uint n, out uint written);
}
'@
$hIn = [Con3]::GetStdHandle(-10)
$logFile = "inject-log-$Tag.txt"
$outFile = "probe-out-$Tag.jsonl"
Remove-Item -Force -ErrorAction SilentlyContinue $outFile, $logFile, "$outFile.helper.log"
$script:t0 = Get-Date
function Note([string]$m) { "[{0,5}ms] {1}" -f [int]((Get-Date)-$script:t0).TotalMilliseconds, $m | Out-File -Append -Encoding utf8 $logFile }
function Get-Mode { $m=0; [void][Con3]::GetConsoleMode($hIn,[ref]$m); return $m }
function Note-Mode([string]$l) { $m=Get-Mode; Note ("{0} mode=0x{1:X4} VT_INPUT={2}" -f $l,$m,(($m -band 0x0200) -ne 0)) }
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
function Send-Records([byte[][]]$records,[string]$label) {
  $flat = New-Object byte[] (20*$records.Count)
  for ($i=0;$i -lt $records.Count;$i++){ $records[$i].CopyTo($flat,20*$i) }
  $w=0; $ok=[Con3]::WriteConsoleInput($hIn,$flat,[uint32]($flat.Length/20),[ref]$w)
  Note "inject $label ok=$ok written=$w"
}
$SHIFT=[uint32]0x0010; $VK_TAB=[uint16]0x09

Note "node_exe=$NodeExe"
$p = Start-Process -FilePath $NodeExe -ArgumentList 'probe-vt2.mjs','9',$outFile,"$here\force-vt-helper.ps1",'3' -NoNewWindow -PassThru
Start-Sleep -Milliseconds 1500
Note-Mode 'during_rawmode'
Send-Records @((New-KeyRecord $true $VK_TAB 0x0F 0x0009 $SHIFT),(New-KeyRecord $false $VK_TAB 0x0F 0x0009 $SHIFT)) 'Shift+Tab#1_baseline'
# helper spawns at t=3s inside the probe; give it time to finish
Start-Sleep -Milliseconds 4200
Note-Mode 'after_helper'
Send-Records @((New-KeyRecord $true $VK_TAB 0x0F 0x0009 $SHIFT),(New-KeyRecord $false $VK_TAB 0x0F 0x0009 $SHIFT)) 'Shift+Tab#2_after_helper'
$p.WaitForExit()
Note-Mode 'after_exit'
Note 'done'
