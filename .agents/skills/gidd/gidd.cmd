@echo off
setlocal DisableDelayedExpansion
if /i "%~1"=="tools" goto :tools
if /i "%~1"=="bootstrap" goto :retired
if not exist "%USERPROFILE%\.agents\skills.tools\gidd\js_exec.cmd" goto :missing
rem Tail-transfer to the generated launcher; CALL would expand user arguments twice.
"%USERPROFILE%\.agents\skills.tools\gidd\js_exec.cmd" "%~dp0scripts\gidd.mjs" %*

:missing
>&2 echo GIDD runtime launcher missing. Run gidd.cmd tools --ensure.
echo {"schema":"gidd.cli/v1","status":"error","reason":"bootstrap_required"}
exit /b 2

:retired
>&2 echo GIDD bootstrap was removed. Run gidd.cmd tools --ensure or tools --check.
echo {"schema":"gidd.cli/v1","status":"error","reason":"bootstrap_removed_use_tools"}
exit /b 2

:tools
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\windows\bootstrap.ps1" %*
exit /b %ERRORLEVEL%
