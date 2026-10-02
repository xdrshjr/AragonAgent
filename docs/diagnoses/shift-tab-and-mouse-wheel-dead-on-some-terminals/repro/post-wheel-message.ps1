# Third probe: a REAL wheel notch, not an injected INPUT_RECORD.
#
# WriteConsoleInput cannot answer the wheel question. conhost's mouse-to-VT
# translation (`HandleTerminalMouseEvent` -> `InputBuffer::WriteMouseEvent`) sits
# on the WINDOW-MESSAGE path, so a record pushed straight into the input buffer
# skips it entirely. Posting WM_MOUSEWHEEL to the console window enters that path
# without moving the user's pointer or stealing focus.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File post-wheel-message.ps1 -NodeExe <node.exe> -Tag <tag>

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
public static class Win {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("user32.dll")]   public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")]   public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
Add-Type -TypeDefinition $source

$log = "wheelmsg-log-$Tag.txt"
$outFile = "probe-wheelmsg-$Tag.jsonl"
Remove-Item -Force -ErrorAction SilentlyContinue $log, $outFile
function Note([string]$s) { $s | Out-File -Append -Encoding utf8 $log }

$hwnd = [Win]::GetConsoleWindow()
Note "console_hwnd=$hwnd"
if ($hwnd -eq [IntPtr]::Zero) { Note 'no console window - inconclusive'; exit 1 }

$r = New-Object Win+RECT
[void][Win]::GetWindowRect($hwnd, [ref]$r)
Note ("window_rect=({0},{1})-({2},{3})" -f $r.Left, $r.Top, $r.Right, $r.Bottom)
$x = [int](($r.Left + $r.Right) / 2)
$y = [int](($r.Top + $r.Bottom) / 2)

$p = Start-Process -FilePath $NodeExe -ArgumentList 'probe-stdin.mjs', '10', $outFile `
                   -NoNewWindow -PassThru
Start-Sleep -Milliseconds 1800

$m = 0; [void][Win]::GetConsoleMode([Win]::GetStdHandle(-10), [ref]$m)
Note ("in_mode_during=0x{0:X4}  VT_INPUT={1}" -f $m, (($m -band 0x0200) -ne 0))

$WM_MOUSEWHEEL = 0x020A
# wParam: HIWORD = wheel delta (+120 up / -120 down), LOWORD = virtual key state.
# lParam: screen coordinates of the pointer.
function Post-Wheel([int]$delta, [string]$label) {
  $wParam = [IntPtr](([int64]([uint16]$delta) -shl 16))
  $lParam = [IntPtr](([int64]($y -band 0xFFFF) -shl 16) -bor ([int64]($x -band 0xFFFF)))
  $ok = [Win]::PostMessage($hwnd, $WM_MOUSEWHEEL, $wParam, $lParam)
  Note "post $label ok=$ok wParam=$wParam lParam=$lParam"
  Start-Sleep -Milliseconds 400
}

Post-Wheel 120   'WheelUp'
Post-Wheel 120   'WheelUp2'
Post-Wheel 65416 'WheelDown'   # (-120) as an unsigned 16-bit value

$p.WaitForExit()
Note 'done'
