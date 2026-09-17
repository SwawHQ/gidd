GIDD prerequisites preparation (Windows x64 / PowerShell 5.1)

  gidd.pre.ensure help en          #Show English help
  gidd.pre.ensure help zh          #Show Chinese help
  gidd.pre.ensure --repo <path>    #Ensure JS runtime, Git and gh are available; create the repository's gidd.link.cmd
  gidd.pre.ensure --repo <path> --jsruntime=node #As above, selecting Node (otherwise, GIDD auto-selects Bun or Node)
  gidd.pre.ensure --repo <path> --force #Download and set up portable copies of the JS runtime, Git and gh again
  gidd.pre.ensure --repo <path> --check #Check availability (read-only)
  gidd.pre.ensure --tools-only=git #Prepare only git; --tools-only cannot be combined with --repo; likewise below
  gidd.pre.ensure --tools-only=gh
  gidd.pre.ensure --tools-only=bun
  gidd.pre.ensure --tools-only=node
  gidd.pre.ensure --tools-only=git --check  #Read-only check (using git as an example)
  gidd.pre.ensure --tools-only=git --force  #Download and set up a portable copy again (using git as an example)
