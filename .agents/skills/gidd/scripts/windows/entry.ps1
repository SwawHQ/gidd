# Keep CLI arguments literal; the internal dispatcher accepts typed development options.
. (Join-Path $PSScriptRoot 'lib/_entry.ps1')
Invoke-GiddEntry -CommandArguments $args
