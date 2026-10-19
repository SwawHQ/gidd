@echo off
setlocal DisableDelayedExpansion
set "GIDD_ENTRY_DIRECTORY=%~dp0"
set "GIDD_ENTRY_LOADER=import(require('node:url').pathToFileURL(process.env.GIDD_ENTRY_DIRECTORY+'scripts.js/entry.mjs').href).then(m=>m.start()).catch(()=>{console.error('GIDD: entry_unavailable. Check the skill installation.');process.exitCode=2})"
rem Node preserves the complete Windows tool exit code; Bun truncates it.
if /i "%~1"=="git" goto :tool
if /i "%~1"=="gh" goto :tool
if /i "%~1"=="bun" goto :tool
if /i "%~1"=="node" goto :tool
if exist "%USERPROFILE%\.agents\skills.tools\gidd\bun.link.cmd" goto :bun
if exist "%USERPROFILE%\.agents\skills.tools\gidd\node.link.cmd" goto :node
rem Use the same preparer as tools.ensure.cmd without CALL re-expansion.
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%GIDD_ENTRY_DIRECTORY%scripts.powershell\bootstrap.ps1" 1>&2
if errorlevel 1 exit /b %ERRORLEVEL%
if exist "%USERPROFILE%\.agents\skills.tools\gidd\bun.link.cmd" goto :bun
if exist "%USERPROFILE%\.agents\skills.tools\gidd\node.link.cmd" goto :node
>&2 echo GIDD: runtime_unavailable. Run tools.ensure.cmd to repair shared tools.
exit /b 2
:tool
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%GIDD_ENTRY_DIRECTORY%scripts.powershell\tool-runtime.ps1"
if errorlevel 1 exit /b %ERRORLEVEL%
goto :node
:bun
"%USERPROFILE%\.agents\skills.tools\gidd\bun.link.cmd" -e "%GIDD_ENTRY_LOADER%" -- %*
:node
"%USERPROFILE%\.agents\skills.tools\gidd\node.link.cmd" -e "%GIDD_ENTRY_LOADER%" -- %*
