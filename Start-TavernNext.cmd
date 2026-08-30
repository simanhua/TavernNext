@echo off
setlocal
chcp 65001 >nul

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-TavernNext.ps1" %*
set "TAVERNNEXT_EXIT_CODE=%ERRORLEVEL%"

if not "%TAVERNNEXT_EXIT_CODE%"=="0" (
  echo.
  echo TavernNext did not start. Review the message above for the exact check that failed.
)

exit /b %TAVERNNEXT_EXIT_CODE%
