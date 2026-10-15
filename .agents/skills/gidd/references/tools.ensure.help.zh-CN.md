GIDD 工具准备（Windows x64）

  tools.ensure.cmd help zh                  #显示中文帮助
  tools.ensure.cmd help en                  #Show English help
  tools.ensure.cmd                          #准备 JS 运行时、Git 和 gh
  tools.ensure.cmd git  [--check | --force] #准备、检查或重新安装 Git
  tools.ensure.cmd gh   [--check | --force] #准备、检查或重新安装 gh
  tools.ensure.cmd node [--check | --force] #准备、检查或重新安装 Node
  tools.ensure.cmd bun  [--check | --force] #准备、检查或重新安装 Bun

  --check 只检查；--force 重新安装指定工具的便携版。
