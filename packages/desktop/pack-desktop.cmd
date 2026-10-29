@echo off
rem Double-click entry point for pack-desktop.ps1 (AragonAgent desktop packaging).
rem Runs Windows PowerShell 5.1 (-NoProfile -ExecutionPolicy Bypass), forwards every argument
rem (paths with spaces included) and never lets a double-click close the window instantly.
rem Every prompt here is bounded: a piped or CI run errors out immediately instead of hanging.
setlocal EnableExtensions
set "PS1=%~dp0pack-desktop.ps1"

if not exist "%PS1%" (
  echo pack-desktop.cmd: pack-desktop.ps1 was not found next to this file.
  echo   expected: "%PS1%"
  echo   restore packages\desktop from a clean checkout and try again.
  call :hold
  exit /b 1
)

where powershell >nul 2>nul
if errorlevel 1 (
  echo pack-desktop.cmd: Windows PowerShell was not found in PATH.
  echo   this launcher needs Windows PowerShell 5.1, powershell.exe.
  call :hold
  exit /b 1
)

echo Running: powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo pack-desktop finished: exit code 0.
) else if "%RC%"=="2" (
  echo pack-desktop stopped with exit code 2 - bad usage.
  echo Run this launcher with -Help to see the switches.
) else (
  echo pack-desktop failed with exit code %RC%.
  echo Read the output above, then run this launcher with -Doctor for a diagnostics report.
)

rem -NoPause anywhere in the arguments means: do not block at the end.
rem shift does not change %*, so the powershell call above already received every argument.
set "SKIPPAUSE=0"

:scan_args
if "%~1"=="" goto after_scan
if /i "%~1"=="-NoPause" set "SKIPPAUSE=1"
shift
goto scan_args

:after_scan
if "%SKIPPAUSE%"=="1" goto close
if not exist "%SystemRoot%\System32\choice.exe" goto hold_then_close
rem Bounded prompt: 30 seconds, default Y (close), so a redirected stdin cannot hang here.
choice /c YN /n /t 30 /d Y /m "Press Y to close, N to keep the window open (auto-closes in 30s): " >nul
if errorlevel 2 goto keep_open
goto close

:hold_then_close
call :hold
goto close

:keep_open
echo.
echo Window kept open. Press any key to close it.
call :hold

:close
exit /b %RC%

:hold
rem timeout.exe refuses a redirected stdin and gives up after its timeout, so this never hangs.
if exist "%SystemRoot%\System32\timeout.exe" (
  "%SystemRoot%\System32\timeout.exe" /t 3600 >nul 2>nul
) else (
  pause
)
exit /b 0
