GIDD（Windows x64 / PowerShell 5.1）
  gidd help en                                          #Show English help
  gidd help zh                                          #显示中文帮助
  gidd lang.set <zh|en>                                 #设置全局默认输出语言
  gidd lang.clear                                       #清除语言设置，恢复按系统语言选择
  gidd doctor                                           #检查工具、仓库、账号和远端访问
  gidd doctor --offline                                 #仅检查本地；可配合 --lang zh|en
  gidd policy.deliveries                                #列出所有交付模式；可配合 --lang zh|en
  gidd policy.list 00                                   #列出 00 号交付模式下的授权方案
  gidd policy 00/00                                     #查看 00/00 授权方案
  gidd policy.history                                   #查看授权方案选用记录；-v 显示时间
  gidd policy.issue 00/00                               #打印指定授权方案的 Issue 模板
  gidd gh.auth                                          #交互登录并选择本仓库的 GitHub 账号
  gidd issue --file <文件> --policy <授权方案>          #从 Markdown 创建 Issue、登记任务并准备工作区
  gidd <Issue编号> --policy <授权方案>                  #登记已有 Issue 并准备或恢复工作区
  gidd <Issue编号>                                      #查看任务和工作区的本地状态
  gidd <Issue编号>.policy                               #查看任务使用的授权方案；可配合 --lang zh|en
  gidd <Issue编号>.policy.set <授权方案>                #更改任务的授权方案
  gidd <Issue编号>.push                                 #按交付模式推送工作分支或目标分支
  gidd <Issue编号>.merge [--squash] [--message <标题>]  #按交付模式做本地或 PR 合并；默认 merge
  gidd <Issue编号>.merge --rebase                       #仅限 02.pr-merge 交付模式
  gidd <Issue编号>.target-sync                          #PR 合并后，同步本地目标分支
  gidd <Issue编号>.close-issue                          #按交付模式核验无误后关闭 Issue
  gidd <Issue编号>.cleanup                              #清理任务记录、工作分支（若有），释放工作区
  gidd worktree.list                                    #列出目标仓库的其他工作树及状态
  gidd worktree.show <目录>                             #查看工作区关联任务和 Git 状态
  gidd worktree.remove <目录>                           #移除已释放的工作区及其登记信息

  gidd git [参数...]                                    #运行已准备的 Git
  gidd gh [参数...]                                     #运行已准备的 GitHub CLI
  gidd bun [参数...]                                    #运行已准备的 Bun
  gidd node [参数...]                                   #运行已准备的 Node.js
  gidd git remote add for.swaw.gidd <url>               #为 GIDD 添加专用远端
