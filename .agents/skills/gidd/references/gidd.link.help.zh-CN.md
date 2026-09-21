GIDD（Windows x64 / PowerShell 5.1）

  gidd.link help en          #Show English help
  gidd.link help zh          #显示中文帮助
  gidd.link doctor           #检查工具、仓库及 GitHub 身份（含联网检查）
  gidd.link doctor --offline #仅检查本地工具、配置和仓库，不联网
  gidd.link set.show         #原样打印 config.toml（TOML）
  gidd.link set <字段> <值>  #设置 config.toml 中指定字段
  gidd.link set spec.current 04.issue.ask-commit  #(示例)设置当前的规范；列出可用规范：gidd.link spec.list
  gidd.link set repo.remote.account bornwhy #(示例)设置 repo.remote.account 的值为 bornwhy
  gidd.link set repo.remote.name origin #(示例)记录对本地仓库使用的远端名
  gidd.link set repo.remote.url <url>   #记录对本地仓库使用的远端 url
  gidd.link set git.credential.mode gh  #(示例)必填;如何为远端 url 提供凭据，可选：gh|inherit
  gidd.link set git.user.mode managed   #(示例)必填;如何为 git 指定署名信息，可选：managed|inherit
  gidd.link set git.user.name <user>    #managed 模式必填，inherit 用 clear 删除；指定 git user.name
  gidd.link set git.user.email <email>  #managed 模式必填，inherit 用 clear 删除；指定 git user.email
  gidd.link clear <字段>            #删除 config.toml 中指定字段
  gidd.link clear git.user.name     #(示例)删除 git.user.name（inherit 模式还必须删除 git.user.email）
  gidd.link spec.list               #每行列出一个规范及摘要；阅读全文：gidd.link spec <规范名>
  gidd.link spec.current            #打印当前应用的规范
  gidd.link spec.current --lang zh  #同上，但指定语言，可选 zh|en，下同
  gidd.link spec 04.issue.ask-commit       #打印名为 04.issue.ask-commit 的规范
  gidd.link spec.issue.current      #打印当前规范要求的 GitHub Issue 模板
  gidd.link spec.issue 04.issue.ask-commit #同上，但目标规范被指定为 04.issue.ask-commit
  gidd.link .gh.auth            #检查配置的账号的凭据；缺失时发起交互式登陆授权(凭据由 gh 管理)
  gidd.link .gh <gh 原生参数>   #按配置提供账号、目标仓库和 Git 后转发 gh；禁用常见交互
  gidd.link .git <git 原生参数> #按配置提供身份和 HTTPS 凭据后转发 Git；禁用常见交互

包装保留管道输入；需要编辑器或凭据提示时失败。自定义程序的保护边界见 execution.md。
  $env:GIDD_EXEC_TIMEOUT_MS=600000 #可选：限制转发命令为 10 分钟；默认不限时，超时退出 124
