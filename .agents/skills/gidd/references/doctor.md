# Windows 本地诊断

完整 doctor 位于 scripts/doctor.mjs，本身只读、离线。系统入口直接调用 [bootstrap](bootstrap.md) 已生成的 js_exec.cmd；启动器缺失时提示 bootstrap --yes，doctor 尚未执行。

公开入口：`gidd.cmd doctor`。当前验证平台为 Windows x64、Windows PowerShell 5.1；需要 bootstrap 已准备共享运行时启动器；不要求 gh 已安装。

从目标仓库的 `.agents/skills/gidd/` 安装目录执行：

```powershell
.\gidd.cmd doctor
```

仓库内 `.agents/skills/gidd/` 的入口自动定位含 `.git` 标记的目标根（含 worktree），不依赖工作目录。Git 可用时另行验证工作树；配置不继承用户级文件。入口无法确定目标时，doctor 仍检查工具，repository 报 target_required，repository 字段为 null；Agent 先确认目标，不能把用户级技能安装目录或调用目录猜成目标。显式目标是普通目录时报告 not_git_repository，目录不存在时报告 directory_missing。工具固定存放于 `~/.agents/skills.tools/gidd/`，独立于技能安装位置，JS doctor 不建立工具目录。

## 源码归属

scripts/doctor.mjs 组合诊断；scripts/tools.mjs 负责工具探测；scripts/storage.mjs 负责配置、固定路径与完整性校验；scripts/config.mjs 提供共用 GitHub 字段校验；scripts/github.mjs 的共用进程执行器提供超时、输出上限和错误脱敏。scripts/windows/doctor.ps1 仅为经共享启动器转发的旧 PowerShell 兼容入口。

## 工具选择

先检查固定共享目录中的同名 executable，再检查 PATH 候选。gh 固定版本必须精确匹配，否则该候选报告 configured_version_mismatch；内部下载策略只用于需要下载时解析，doctor 不联网查询最新版本或 LTS 状态。仅执行 `--version`，每个子进程最多等待 5 秒，stdin 关闭。首版不运行 `.cmd` 包装器，不修改 PATH。

共享工具须先通过同目录 `install.json` 的文件集合、长度、SHA-256 检查，再运行版本查询；缺少清单或文件损坏时报告 `managed_integrity_failed`，不执行该候选。此校验不适用于外部管理的普通 PATH 工具。若将 GIDD 的同一工具路径加入 PATH，仍需通过共享工具完整性检查。

进程退出和 stdout/stderr 读取共用同一个 5 秒期限；父进程退出后，后代仍持有输出管道时也会返回 `process_timeout`，不会重新开始计时或无限等待。辅助函数不负责终止所有后代进程。

| 工具 | 基础版本门槛 | 受管候选（先于 PATH） |
| --- | --- | --- |
| Git | 2.0 | 无 |
| Node.js | 只观察版本，不检查兼容性 | `<工具根>/node/node.exe`；可用 `gidd.cmd bootstrap --node --yes` 准备并选择 |
| Bun | 只观察版本，不检查兼容性 | `<工具根>/bun/bun.exe` |
| gh | 2.98.0 | `<工具根>/gh/gh.exe` |

runtime 描述当前正在执行 doctor 的进程：path、version、selected 与 compatibility_checked=false。不重新选择运行时，也不执行兼容方法。tool.node/bun 是对安装文件和 --version 的独立观察，候选拒绝原因保留在 details.rejected；这不等于 bootstrap 的兼容结果。

上述版本是诊断门槛，不证明所有对应版本的未来业务兼容性。JavaScript 业务代码须使用 Node/Bun 共同支持的标准 API，同一功能在两者上验证；doctor 由共用 JavaScript 执行，测试同时覆盖 Node 与 Bun。

## 输出与退出码

stdout 为单个 UTF-8 JSON 对象：

```json
{
  "schema": "gidd.doctor/v1",
  "status": "needs_setup",
  "repository": "D:\\work\\project",
  "checks": [
    { "id": "runtime", "status": "ready", "reason": "current_process", "details": { "selected": "tool.bun", "compatibility_checked": false } }
  ]
}
```

示例省略其他检查项。`reason` 是稳定标识，Agent 自行用用户语言解释；不得依赖检查项顺序。

| 项状态 | 含义 |
| --- | --- |
| `ready` | 通过该项明确限定的检查 |
| `missing` | 未找到所需对象 |
| `invalid` | 对象存在但不可用，或目标不是可读取工作树 |
| `not_checked` | 前置条件缺失、未实现或不属于离线诊断 |

| 退出码 / 总体状态 | 含义 |
| --- | --- |
| `0` / `local_ready` | 平台、Git、当前运行时、gh、工作树、commit、配置 schema、GitHub 必需字段及所选 remote 的本地主机匹配均通过 |
| `1` / `needs_setup` | 正常完成诊断，基础条件尚不齐备 |
| `2` / `error` | 调用参数错误或诊断程序无法完成；stderr 提供说明 |

检查项为 `platform`、`tools.storage`、`tool.git`、`tool.node`、`tool.bun`、`tool.gh`、`runtime`、`repository`、`repository.history`、`repository.remotes`、`repository.remote`、`repository.config`、`repository.config.validation`、`repository.config.github`、`github.identity`、`git.authentication`。无法读取工作树时，history/remotes/remote 为 not_checked；没有 commit 的新仓库报告 unborn_branch。

`repository.config` 检查固定路径文件存在性；`repository.config.validation` 验证 [configuration.md](configuration.md) 的 schema v1；`repository.config.github` 使用共用字段校验器检查 hostname/account/remote，分别列出 missing_fields 与 invalid_fields，不输出字段原值。目标明确时，即使缺少 Git 或尚未建立 Git 仓库，也检查该位置的配置。配置存在和字段完整都不是初始化记录。

`tools.storage` 只报告工具配置和解析位置，不输出 GitHub 字段。配置语法或工具存储错误时该项为 invalid，managed_tools_checked=false，仅继续外部 PATH 探测，不回退默认受管目录。GitHub 字段值错误单独报告，不阻止工具诊断。Git 也优先检查受管 git/cmd/git.exe，再检查 PATH；通过校验的所选路径用于所有仓库探测。source=managed 表示受管工具，实际位置以 tools.storage 为准。GitHub 身份与 Git 传输认证仍为 not_checked；local_ready 不代表仓库启用、账号正确或具备推送权限。

remote 检查只执行本地 Git 查询，不访问网络。`repository.remotes` 列出本地 remote；`repository.remote` 检查 config.toml 的 github.remote，存在其他 remote 不代表所选 remote 可用。读取所选 remote 的 fetch URL（Git 展开 insteadOf 后），要求恰好一个地址，多个地址报告 remote_url_ambiguous。

支持 `https://host/owner/repo`、`git@host:owner/repo`、`ssh://git@host[:port]/owner/repo`，可带 .git 后缀与末尾斜线。主机忽略大小写，与 github.hostname 比较，成功时给出 hostname 和 github_repository；这只表示地址结构与配置主机匹配，不能离线证明该主机运行 GitHub 或仓库真实存在。含 HTTPS 凭据、查询参数、片段、百分号编码、额外路径、其他协议或 SSH 别名等无法匹配的形式，需要用户另行检查，不自动修改 remote。不会输出完整 URL、非法配置值或子进程原始错误。

| 检查原因 | Agent 应说明的情况 |
| --- | --- |
| target_required | 尚未确定目标目录，先确认目标 |
| git_unavailable | Git 程序不可用，不能判断仓库状态 |
| not_git_repository / not_worktree | 目标尚非 Git 仓库或不是工作树 |
| no_remotes | 工作树未配置 remote |
| github_fields_missing / github_fields_invalid | 配置缺项或字段值无效，按字段列表处理 |
| configured_remote_missing | 配置指定的 remote 不存在 |
| remote_hostname_mismatch | 所选 remote 的主机与配置不符，需确认目标或修正设置 |
| unsupported_remote_url / remote_url_ambiguous | 当前离线解析无法确定单一目标，需核对地址 |

这里只检查所选 fetch 地址，不验证 push URL、推送权限或仓库归属记录；归属记录与初始化流程尚未实现。不把这些原因统一解释为需要重新初始化。

## Agent 如何使用结果

- bootstrap 只负责运行时与共享启动器，不检查 Git、仓库归属或登录；Git 和 gh 的可用性由 JS doctor 报告。
- 用户说“当前仓库启用 GIDD”：先对明确的目标仓库诊断。已有运行时通过时直接复用，不要求同时安装 Node 和 Bun。
- 启动失败：报告共享启动器或运行时执行错误，提示重新 bootstrap。完整 doctor 尚未执行，不把未检查项报告为通过。
- `repository.config` 缺失：说明该仓库尚无固定位置配置，再按用户授权进入配置流程；不要用目录存在代替启用记录。
- `github.identity` 未检查：说明尚未检查，不能说“未登录”。用户要求检查当前账号时使用独立的 [身份检查入口](identity.md)，该入口会联网。需要登录时另行展示 URL 与一次性代码，当前 doctor 不启动登录。
- 初始化或修复后重新诊断。退出码 1 不是脚本崩溃；不要无条件重复执行或把结果当作自动安装授权。

doctor 自身不安装工具、不写目标仓库或工具目录、不切换账号、不写 Git 配置、不修改全局环境。它会执行找到的本机 executable 的版本查询，不能保证任意第三方 executable 本身没有副作用。
