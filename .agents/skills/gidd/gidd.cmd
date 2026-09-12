@echo off
setlocal DisableDelayedExpansion
if not exist "%USERPROFILE%\.agents\skills.tools\gidd\js_exec.cmd" goto :missing
rem Tail-transfer to the generated launcher; CALL would expand user arguments twice.
"%USERPROFILE%\.agents\skills.tools\gidd\js_exec.cmd" "%~dp0scripts\gidd.mjs" %*

:missing
>&2 echo GIDD runtime launcher missing. Run gidd.pre.ensure.cmd --repo with the target directory.
echo {"schema":"gidd.cli/v1","status":"error","reason":"bootstrap_required"}
exit /b 2
