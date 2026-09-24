GIDD（Windows x64 / PowerShell 5.1）

  gidd.link help en          #Show English help
  gidd.link help zh          #显示中文帮助
  gidd.link doctor           #运行 references/doctor.toml 启用的检查（含联网检查）
  gidd.link doctor --offline #仅检查本地工具、配置和仓库，不联网
  gidd.link doctor --lang zh #指定 zh|en；默认取 GIDD_LANG，再取系统语言；可搭配 --offline
  gidd.link set.show         #原样打印 config.toml（TOML）
  gidd.link set <字段> <值>  #设置 config.toml 中指定字段
  gidd.link set spec.current 00/00        #选择当前规范
  gidd.link set repo.remote.account bornwhy #(示例)设置 repo.remote.account 的值为 bornwhy
  gidd.link set repo.remote.name origin #(示例)记录对本地仓库使用的远端名
  gidd.link set repo.remote.url <url>   #记录对本地仓库使用的远端 url
  gidd.link set git.credential.mode gh  #(示例)必填;如何为远端 url 提供凭据，可选：gh|inherit
  gidd.link set git.user.mode managed   #(示例)必填；managed 使用配置中的姓名和邮箱，inherit 沿用 Git 身份
  gidd.link set git.user.name <user>    #managed 模式必填，inherit 用 clear 删除；指定 git user.name
  gidd.link set git.user.email <email>  #managed 模式必填，inherit 用 clear 删除；指定 git user.email
  gidd.link clear <字段>            #删除 config.toml 中指定字段
  gidd.link clear git.user.name     #(示例)删除 git.user.name（inherit 模式还必须删除 git.user.email）
  gidd.link spec.modes                    #列出模式目录名、简介及可用规范数量
  gidd.link spec.list 00                  #列出 00 模式的规范及授权配置
  gidd.link spec 00/00                    #生成指定规范提示
  gidd.link spec.current                  #生成当前规范提示
  gidd.link spec.current --lang zh        #指定 zh|en；各 spec 命令均支持 --lang
  gidd.link spec.issue 00/00              #打印指定规范的 Issue 模板
  gidd.link spec.issue.current            #打印当前规范的 Issue 模板
  gidd.link .gh.auth            #检查配置的账号的凭据；缺失时发起交互式登陆授权(凭据由 gh 管理)
  gidd.link .gh <gh 原生参数>   #按配置提供账号、目标仓库和 Git 后转发 gh；禁用常见交互
  gidd.link .git <git 原生参数> #按配置提供身份和 HTTPS 凭据后转发 Git；禁用常见交互

包装保留管道输入；需要编辑器或凭据提示时失败。自定义程序的保护边界见 execution.md。
  $env:GIDD_EXEC_TIMEOUT_MS=600000 #可选：限制转发命令为 10 分钟；默认不限时，超时退出 124
