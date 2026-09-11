@echo off
setlocal DisableDelayedExpansion
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
set "GIDD_DEV_SOURCE=managed"
if /i "%~1"=="bun" goto :runtime
if /i "%~1"=="node" goto :runtime
if /i "%~1"=="sys" if /i "%~2"=="bun" goto :systemRuntime
if /i "%~1"=="sys" if /i "%~2"=="node" goto :systemRuntime
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0dev\windows.ps1" %*
exit /b %ERRORLEVEL%

:systemRuntime
set "GIDD_DEV_SOURCE=system"
:runtime
set "GIDD_DEV_NAME=%~1"
if "%GIDD_DEV_SOURCE%"=="system" set "GIDD_DEV_NAME=%~2"
set "GIDD_DEV_RUNTIME="
rem Resolve only the runtime in PowerShell; user arguments go directly to Node/Bun.
for /f "tokens=2 delims=:" %%C in ('"%SystemRoot%\System32\chcp.com"') do set "GIDD_DEV_CODEPAGE=%%C"
"%SystemRoot%\System32\chcp.com" 65001 >nul
for /f "delims=" %%R in ('@ "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0dev\windows.ps1" .runtime-path %GIDD_DEV_NAME% %GIDD_DEV_SOURCE%') do set "GIDD_DEV_RUNTIME=%%R"
"%SystemRoot%\System32\chcp.com" %GIDD_DEV_CODEPAGE% >nul
if not defined GIDD_DEV_RUNTIME exit /b 1
"%GIDD_DEV_RUNTIME%" "%~dp0dev\runtime.mjs" %*
exit /b %ERRORLEVEL%
