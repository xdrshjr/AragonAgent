# Production-shaped helper: a CHILD of the CLI, spawned with stdio 'ignore', so
# GetStdHandle(STD_INPUT_HANDLE) would hand back NUL. It must therefore reach the
# console through CONIN$, which stays valid as long as the child is attached to
# the same console.
param([string]$LogFile = 'force-vt-helper.log')

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VtIn {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa,
                                          uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetConsoleMode(IntPtr h, uint m);
}
'@

# Decimal literals: PowerShell 5.1 parses 0x80000000 as a SIGNED Int32, and the
# [uint32] cast then throws (same trap the round-1 wheel script documented).
$GENERIC_READ  = [uint32]2147483648
$GENERIC_WRITE = [uint32]1073741824
$SHARE_RW      = [uint32]3
$OPEN_EXISTING = [uint32]3

$h = [VtIn]::CreateFileW('CONIN$', ($GENERIC_READ -bor $GENERIC_WRITE), $SHARE_RW,
                         [IntPtr]::Zero, $OPEN_EXISTING, 0, [IntPtr]::Zero)
$m = 0
$gotMode = [VtIn]::GetConsoleMode($h, [ref]$m)
$new = $m -bor 0x0200
$ok = [VtIn]::SetConsoleMode($h, $new)
$after = 0
[void][VtIn]::GetConsoleMode($h, [ref]$after)
"handle=$h got=$gotMode before=0x{0:X4} set=0x{1:X4} ok={2} after=0x{3:X4}" -f $m, $new, $ok, $after |
  Out-File -Encoding utf8 $LogFile
