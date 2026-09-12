# 仓库专用入口

Windows 首次准备一个目标仓库，或修复缺失/失效的仓库入口时，调用实际技能安装目录中的：

```text
gidd.pre.ensure.cmd --repo <目标仓库绝对路径>
gidd.pre.ensure.cmd --repo <目标仓库绝对路径> --jsruntime=node
gidd.pre.ensure.cmd --repo <目标仓库绝对路径> --force
gidd.pre.ensure.cmd --repo <目标仓库绝对路径> --check
```

除帮助外，--repo 必须明确提供本地盘上的 Git 工作树根目录，不推断 cwd，也不把传入的子目录自动提升到父仓库。保留 --repository 作为兼容别名；同一参数重复或两种写法混用均报错。默认执行准备，--check 只读检查；不接受 --ensure。--check 不得与 --force 或 --jsruntime 搭配。--force 和运行时选择沿用 [tools 协议](bootstrap.md)，不会覆盖未知文件。

查看帮助使用 `gidd.pre.ensure.cmd help zh` 或 `help en`；不带参数、`help`、`--help`、`-h` 均显示帮助，帮助别名也可追加语言。语言选择与 `gidd help` 一致：显式语言、GIDD_LANG、LC_ALL、LC_MESSAGES、LANG、系统界面语言依次取首个非空值；显式语言或 GIDD_LANG 仅接受 zh/en 及其地区变体，其他系统语言回退英文。帮助由原生 Shell 读取 `scripts/help/pre-ensure/` 下的 UTF-8 文本，无需仓库参数或 JS 运行时，不读取配置、准备工具或写入文件；成功输出文本并退出 0。

## 验证及执行顺序

1. 原生 Shell 在准备工具前检查参数、绝对目录、路径及根目录的 .git 标记；拒绝不存在目录、普通目录、仓库子目录和被目录占用的链接位置。worktree 的 .git 文件也允许进入下一步。
2. 复用现有运行时准备事务；JS 检查目标链接是否为可识别的生成文件，随后准备或复用 Git。
3. 共用 JS 使用选定 Git 验证工作树及实际根目录，再检查本地 remote 地址。runCommand 隔离 GIT_DIR/GIT_WORK_TREE 等重定向变量；不受调用目录影响。
4. 验证通过后准备或复用 gh；再次核对目标后，原子发布 .agents/skills/gidd/gidd.link.cmd。

目标配置存在时读取它，不改写；github.hostname 未配置时，此次安装前置检查使用 github.com。配置指定 github.remote 时只检查它；未指定时要求至少一个 remote 的单一 fetch URL 可识别为该主机的 owner/repo。允许 HTTPS 和 SSH，复用 doctor 的地址解析。成功结果列出通过检查的 remote，不替用户写入配置或选择业务 remote。GitHub Enterprise 可在目标配置中明确 hostname。

这只是本地地址检查，不联网验证远端仓库存在、权限或主机服务类型；不要求 HEAD、commit 作者或登录已经可用。没有提交但具备 remote 的工作树可以建立入口。push 目标与初始化归属匹配不属于此阶段，后续配置初始化另行实现。

缺少 Git 时必须先准备它，才能可靠读取工作树和 remote；失败可能留下已成功准备的共享运行时或 Git，但不会发布新链接，不会删除旧链接。工具健康且生成内容相同时复用，不重新下载、不重写启动器、工具绑定或仓库链接；ensure 仍会进行安装完整性和兼容性校验。并发准备遵守共享安装锁，链接写入另用同目录独占锁；遇到占用可以在原进程结束后重试。

## 只读检查

--check 复用完整工具检查，报告运行时兼容性、工具可用性、受管工具完整性、共享启动器及 Git/gh 绑定，并验证目标工作树、GitHub remote 和仓库入口。入口检查比较当前技能应生成的内容，分别报告缺失、内容匹配、指向其他技能或过期、未知文件占用及锁占用。配置文件只读，未配置 github 字段时沿用准备阶段的本地 remote 检查规则。

检查不下载、不创建目录或入口、不写绑定、不恢复中断安装，不改变已有配置。已有可用运行时但共享启动器缺失时，仍可继续 JS 检查；缺少 Git 时仓库检查报告 not_checked/git_unavailable，gh 和入口仍独立检查；缺少 JS 运行时则后续检查报告 not_checked/runtime_unavailable。GitHub remote 不符合时也保留工具和入口的其他检查结果，不联网验证仓库或权限。

结果沿用 gidd.tools/v1，read_only=true；repository_check 与 entry 各自包含 status 和异常 reason，entry 成功为 ready/repository_entry_verified，没有 action，也不输出已准备入口的 message。全部就绪退出 0；缺失、损坏、待恢复或未执行的检查退出 1；参数、目录或配置读取导致原生前置检查失败时退出 2。若配置错误发生在 JS 阶段，后续仓库及入口检查标记为 not_checked，具体配置错误保留在 tool_checks。

## 链接执行与迁移

```text
<目标仓库>/.agents/skills/gidd/gidd.link.cmd help zh
<目标仓库>/.agents/skills/gidd/gidd.link.cmd doctor --offline
<目标仓库>/.agents/skills/gidd/gidd.link.cmd config show
```

可以从任意工作目录调用。链接根据自身位置固定目标，拒绝 --repository 覆盖；帮助无需目标 Git 检查，仓库命令在 Git 标记丢失时拒绝执行，不转向父目录。工具、凭据仍按原规则共享，不承诺所有命令的副作用只发生在仓库内。

生成逻辑在 scripts/repository-entry.mjs。实际 gidd.cmd 位于目标内时，保存从链接到它的相对位置，支持 .agents、.claude 或项目内其他安装位置；外部技能使用绝对位置。链接为 ASCII 批处理，以编码数据保存位置，使用共享 js_exec.cmd 单次启动 JS，再进入真实技能的同一分发器；普通命令不调用 PowerShell，不切换代码页，不重复通过 CALL 展开参数。所有仓库命令直接进入 JS；运行前准备独立调用 gidd.pre.ensure.cmd。

完整项目移动后，相对入口继续有效；外部技能位置不变时，绝对入口也会根据链接的新位置定位目标。实际技能移动、更新或共享启动器丢失时，重新调用实际技能的 gidd.pre.ensure.cmd；不搜索其他副本、不回退重跑。链接缺失表示入口需要准备，不代表配置需要丢弃或重新登录。

只更新内容完整匹配 GIDD 生成格式的链接，未知或编辑过的同名文件保留并报错。临时文件刷盘后替换，失败保留旧入口；相同内容不改写。config.toml 不在此命令中创建或修改，config init、初始化归属记录及 doctor 评级尚未实现。

## 结果与发布

除帮助外，stdout 为单个 gidd.tools/v1 JSON，保留运行时、工具及各阶段检查结果，增加 repository、repository_check、entry 和成功时的 message。entry 成功包括 action=created|updated|reused、path、target、location=relative|absolute。失败未发布链接时 entry.status=not_published，已有链接仍保留。成功退出 0，JS 工具或仓库检查失败退出 1，参数或原生前置检查失败退出 2。

gidd.link.cmd 及其锁/临时文件为生成数据，发布或复制技能时排除它们，保留目标已有配置；本仓库使用精确的 .gitignore 规则排除这些文件。新机器或插件路径变化后重新生成。config.toml 的提交策略仍独立处理，不忽略整个 .agents 目录。当前仅验证 Windows x64；生成与路径逻辑使用共用 JS，但 Linux/macOS 启动器尚未提供。
