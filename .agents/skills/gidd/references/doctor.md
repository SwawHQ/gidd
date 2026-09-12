# Windows 可用性诊断

公开入口：

```powershell
.\gidd.cmd doctor
.\gidd.cmd doctor --offline
```

doctor 默认执行本地诊断和只读联网检查；--offline 跳过所有联网请求，仍检查工具、配置、工作树、作者及 remote 地址。平台为 Windows x64 / Windows PowerShell 5.1。identity 命令、独立脚本和协议已删除，不提供兼容入口；报告继续使用 gidd.doctor/v1。

## 执行与工具边界

入口通过 gidd.pre.ensure --repo <repository-path> 发布的 js_exec.cmd 启动 scripts/gidd.mjs。启动器缺失或运行时无法启动时，JS doctor 尚未执行，应运行 gidd.pre.ensure --repo <repository-path>；不通过其他运行时回退重跑。

doctor 只验证当前执行链：

- js_runtime 来自当前进程的运行时种类、路径和版本。成功进入 doctor 证明本次启动链可运行；不再次调用兼容脚本，也不探测另一个运行时。
- scripts/bindings.mjs 读取一次固定共享目录中的 tool-bindings.json，检查 schema、平台、字段和路径格式。
- 对已绑定 Git、gh 各执行一次 --version，最多等待 5 秒；要求版本可解析、达到现有最低要求且与绑定记录一致。失败返回具体 reason 和 gidd.pre.ensure --repo <repository-path> 提示，不搜索 PATH 或选用替代工具。
- 工具根直接按固定用户路径解析，不依赖仓库工具下载配置。配置损坏仍可报告已绑定工具的状态。

三个工具的成功 details 统一提供 gidd_managed 布尔值，不再输出 source：true 表示 GIDD 管理的工具，false 表示复用的外部工具。Git/gh 根据已发布绑定的管理归属报告；js_runtime 将当前进程的真实可执行路径与固定工具根下 bun/bun.exe 或 node/node.exe 比较。工具根和当前执行路径解析目录联接，指向外部运行时的联接不会仅因入口位于工具根下就被视为受管。这是管理归属说明，不代表完整安装校验。

不检查安装清单、完整文件哈希、其他运行时、候选工具、安装缓存或恢复事务。gidd.pre.ensure --repo <repository-path> --check 保留完整工具诊断；gidd.pre.ensure --repo <repository-path> 负责准备、校验和修复，并报告其自身错误。基本版本调用成功不证明所有工具组件或业务调用均可用。

## 本地检查

仓库内 .agents/skills/gidd/ 入口从自身位置定位含 .git 标记的目标根，支持 worktree，不依赖 cwd。无明确目标时 repository=null，repository.reason=target_required；不猜测用户级技能目录为目标。

配置只读取目标仓库 .agents/skills/gidd/config.toml。config 一项组合文件读取、schema 及 github.hostname/account/remote 字段校验；缺失或非法字段才列出 missing_fields/invalid_fields，不输出非法值。缺少 Git、普通目录或绑定错误不阻止明确目标的配置检查。配置不补默认账号、主机或 remote。

repository 组合工作树与 HEAD 检查，成功给出根路径和 commit；新仓库没有提交时报告 unborn_branch。可读工作树即使尚无提交，仍检查作者和 remote。损坏 .git 标记、普通目录、bare repository、目录不存在分别报告 not_readable_worktree、not_git_repository、not_worktree、directory_missing。

git.author 使用 git var GIT_AUTHOR_IDENT，报告当前进程的有效姓名与邮箱，不推断 GitHub 身份。

repository.remote 只诊断配置指定的 remote，不列出其他 remote。使用 Git 展开 insteadOf 后的 fetch URL，要求只有一个地址并匹配 github.hostname。支持 https://host/owner/repo、git@host:owner/repo、ssh://git@host[:port]/owner/repo，可带 .git 和末尾斜线。带凭据、查询参数、片段、百分号编码、不明确路径或多个地址等返回具体原因，不输出原始 URL。

## 联网检查

仅 doctor 默认模式包含：

| 检查 | 行为 |
| --- | --- |
| github.identity | gh api --hostname <host> --method GET user --jq .login，比较实际账号与配置账号，忽略大小写 |
| git.remote_read | 本地 remote 校验通过且为 HTTPS 时，非交互执行 git ls-remote -- <remote> HEAD；空仓库无 HEAD 也可读取成功 |

API 身份检查只依赖 gh、有效 hostname/account；工作树或 Git 检查失败不阻止它。remote 读取依赖可读工作树、可用 Git、有效 hostname/remote 和符合条件的 URL，不依赖 API 请求或作者检查成功。一项失败仍执行独立项。

SSH fetch 地址可通过本地校验，但当前不执行 SSH 联网探测，git.remote_read 为 not_checked / https_remote_required。其他不符合条件的 remote 同样不联网。API 请求失败可能来自网络、凭据或服务问题，不直接解释为未登录。

每个联网子进程最多 15 秒，退出和管道读取共用期限；终止确认最多额外 500 毫秒。关闭 stdin，禁用 Git/GCM 交互和 gh 提示，限制输出为 1 MiB，不传播原始失败输出或 stderr。继承调用环境中的 gh 认证选择，Git 保留现有凭据配置；只给子进程设置已绑定 Git 的 PATH。

doctor 不调用 auth login、auth switch、auth setup-git，不创建提交或执行 push。只在用户明确要求授权时调用 auth，其行为不变。远程读取不确定 Git 传输账号，也不证明推送权限；不再输出永远 not_checked 的 git.authentication 项。仓库启用记录、SSH 身份和推送预检尚未实现。

## 报告和退出码

stdout 为单个 JSON 对象。字段为 schema=gidd.doctor/v1、mode=online|offline、status、repository 和 checks。

正常平台下有九项：js_runtime、git、gh、config、repository、git.author、repository.remote、github.identity、git.remote_read。不支持的平台通过公共入口报错；内部诊断额外给出 platform=unsupported。

成功项仅包含 id、status=ready 和有用的 details，不输出重复 reason 或空 details。异常项包含稳定 reason，工具异常另含 hint=Run gidd.pre.ensure --repo <repository-path>。不能依赖 checks 的顺序。

| 退出码 / 总体状态 | 含义 |
| --- | --- |
| 0 / checks_passed | 默认模式九项检查均通过，仍不证明推送权限或仓库启用 |
| 0 / local_ready | --offline 的本地检查全部通过；两个联网项明确为 not_checked / offline |
| 1 / needs_attention | 诊断正常完成，有失败、缺项、不匹配或非离线原因的未检查项 |
| 2 / error | 参数、平台或入口错误，未完成诊断 |

项状态为 ready、missing、invalid、failed、mismatch、not_checked；unsupported 仅用于内部平台诊断。SSH remote 在默认模式下因读取未检查而返回 needs_attention，不将跳过等同通过。

JS 实现位于 scripts/doctor.mjs，API 账号检查和共用进程执行器位于 scripts/github.mjs；旧 scripts/windows/doctor.ps1 转发相同实现，-Offline 对应 --offline。测试使用离线 fixture 验证默认模式，不接触真实登录；同一套用例在 Node/Bun 执行。诊断不写仓库配置或工具目录，外部 executable 和凭据助手本身的行为由其实现决定。
