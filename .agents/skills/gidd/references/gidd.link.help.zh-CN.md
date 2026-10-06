GIDD（Windows x64 / PowerShell 5.1）

  gidd.link help en          #Show English help
  gidd.link help zh          #显示中文帮助
  gidd.link doctor           #运行 references/doctor.toml 启用的检查（含联网检查）
  gidd.link doctor --offline #仅检查本地工具、配置和仓库，不联网
  gidd.link doctor --lang zh #指定 zh|en；默认取 GIDD_LANG，再取系统语言；可搭配 --offline
  gidd.link set.show         #原样打印 config.toml（TOML）
  gidd.link set <字段> <值>  #设置 config.toml 中指定字段
  gidd.link set spec.current 00/00          #选择当前规范
  gidd.link set repo.remote.account bornwhy #(示例)设置 repo.remote.account 的值为 bornwhy
  gidd.link set repo.remote.name origin     #(示例)记录对本地仓库使用的远端名
  gidd.link set repo.remote.url <url>       #记录对本地仓库使用的远端 url
  gidd.link set git.credential.mode gh  #(示例)必填;如何为远端 url 提供凭据，可选：gh|inherit
  gidd.link set git.user.mode managed   #(示例)必填；managed 使用配置中的姓名和邮箱，inherit 沿用 Git 身份
  gidd.link set git.user.name <user>    #managed 模式必填，inherit 用 clear 删除；指定 git user.name
  gidd.link set git.user.email <email>  #managed 模式必填，inherit 用 clear 删除；指定 git user.email
  gidd.link clear <字段>         #删除 config.toml 中指定字段
  gidd.link clear git.user.name  #(示例)删除 git.user.name（inherit 模式还必须删除 git.user.email）
  gidd.link spec.modes           #列出模式目录名、简介及可用规范数量
  gidd.link spec.modes --lang zh #指定 zh|en；各 spec 命令均支持 --lang
  gidd.link spec.list 00         #列出 00 模式的规范及授权配置
  gidd.link spec 00/00           #生成指定规范提示
  gidd.link spec.current         #生成当前规范提示
  gidd.link spec.issue 00/00     #打印指定规范的 Issue 模板
  gidd.link spec.issue.current   #打印当前规范的 Issue 模板
  gidd.link workflow.workspace <Issue编号>                  #按当前规范核验并快进目标分支，准备工作区
  gidd.link workflow.workspace --resume <Issue编号>         #离线核验本地记录并显示工作区状态
  gidd.link workflow.push <Issue编号>                       #按交付模式推送对应分支
  gidd.link workflow.merge <Issue编号> [--squash|--rebase]  #本地或 PR 合并；默认 merge，可用 --message 指定标题
  gidd.link workflow.target-sync <Issue编号>                #核验 PR 并快进同步目标分支
  gidd.link workflow.close-issue <Issue编号>                #核验交付并关闭 Issue；PR 模式补建关联
  gidd.link workflow.cleanup <Issue编号>                    #核验交付并清理本地资源
  gidd.link worktree.list                                   #列出其他 worktree 的分支及状态
  gidd.link worktree.show <目录>                            #查看流程上下文及实际 Git 状态
  gidd.link worktree.remove <目录>                          #移除已释放且无待保留文件的工作区
  gidd.link .gh.auth             #检查配置的账号的凭据；缺失时发起交互式登陆授权(凭据由 gh 管理)
  gidd.link .gh <gh 原生参数>    #按入口配置提供账号、目标仓库和 Git 后转发 gh；禁用常见交互
  gidd.link .git <git 原生参数>  #按入口配置提供身份和 HTTPS 凭据后转发 Git；禁用常见交互
