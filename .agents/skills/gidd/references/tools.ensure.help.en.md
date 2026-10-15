GIDD tool preparation (Windows x64)
  tools.ensure.cmd help en                   #Show English help
  tools.ensure.cmd help zh                   #Show Chinese help
  tools.ensure.cmd                           #Prepare a JS runtime, Git and gh
  tools.ensure.cmd git [--check | --force]   #Prepare, check or reinstall Git
  tools.ensure.cmd gh [--check | --force]    #Prepare, check or reinstall gh
  tools.ensure.cmd node [--check | --force]  #Prepare, check or reinstall Node
  tools.ensure.cmd bun [--check | --force]   #Prepare, check or reinstall Bun

  --check makes no changes; --force reinstalls the selected portable tool.
