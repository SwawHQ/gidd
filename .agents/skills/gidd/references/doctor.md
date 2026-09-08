# Windows 基础诊断

公开入口：`gidd.cmd doctor`。当前验证平台为 Windows x64、Windows PowerShell 5.1；不要求先安装 Bun、Node 或 gh。

从目标仓库的 `.agents/skills/gidd/` 安装目录执行：

```powershell
.\gidd.cmd doctor
```

仓库内 `.agents/skills/gidd/` 的入口自动定位含 `.git` 标记的目标根（含 worktree），不依赖工作目录。Git 可用时另行验证工作树；配置不继承用户级文件。工具固定存放于 `~/.agents/skills.tools/gidd/`，独立于技能安装位置，doctor 不建立工具目录。

## 源码归属

`scripts/windows/doctor.ps1` 负责参数、显式加载、组合检查与 JSON/退出码；`scripts/windows/doctor/` 是其私有实现目录：

| 文件 | 职责 |
| --- | --- |
| `platform.ps1` | Windows 平台与架构 |
| `tools.ps1` | executable 候选、版本检查及 Node/Bun 选择 |
| `repository.ps1` | Git 工作树、commit、remote |
| `configuration.ps1` | 仓库配置文件存在性及工具存储 schema 验证状态 |

这些 `.ps1` 文件由入口 dot-source 加载，不是独立命令或 `.psm1` 模块。领域检查按职责命名，新增检查由入口显式调用，不扫描目录自动执行。doctor 与 setup-tools 现在共同使用 `scripts/windows/lib/` 的 `_process.ps1`（子进程）、`_tools.ps1`（工具探测）和 `_managed.ps1`（安装清单与完整性检查），以及 `_configuration.ps1`（工具存储配置与路径）。下划线表示内部辅助命名约定，不具有 PowerShell 访问控制语义。

## 工具选择

依次检查 PATH 中的同名 `.exe`，失败后尝试配置解析出的受管工具目录。固定版本必须精确匹配，否则该候选报告 configured_version_mismatch；lts/latest 只用于需要下载时解析，doctor 不联网查询最新版本或 LTS 状态。仅执行 `--version`，每个子进程最多等待 5 秒，stdin 关闭。首版不运行 `.cmd` 包装器，不修改 PATH。

共享工具须先通过同目录 `install.json` 的文件集合、长度、SHA-256 检查，再运行版本查询；缺少清单或文件损坏时报告 `managed_integrity_failed`，不执行该候选。此校验不适用于外部管理的普通 PATH 工具。若将 GIDD 的同一工具路径加入 PATH，仍需通过共享工具完整性检查。

进程退出和 stdout/stderr 读取共用同一个 5 秒期限；父进程退出后，后代仍持有输出管道时也会返回 `process_timeout`，不会重新开始计时或无限等待。辅助函数不负责终止所有后代进程。

| 工具 | 基础版本门槛 | PATH 后的候选 |
| --- | --- | --- |
| Git | 2.0 | 无 |
| Node.js | 22.0 | `<工具根>/node/node.exe`；可用 `gidd.cmd setup node` 准备 |
| Bun | 1.2 | `<工具根>/bun/bun.exe` |
| gh | 2.0 | `<工具根>/gh/gh.exe` |

Node 和 Bun 任一种可用即可满足 `runtime`。PATH 中可用运行时优先于共享工具；来源相同时优先 Bun。`tool.node` 缺失而 Bun 可用，不阻止总体本地就绪。拒绝的候选及原因保留在 `details.rejected`。

上述版本是诊断门槛，不证明所有对应版本的未来业务兼容性。JavaScript 业务代码须使用 Node/Bun 共同支持的标准 API，同一功能在两者上验证；当前 doctor 不执行 JavaScript 业务代码。

## 输出与退出码

stdout 为单个 UTF-8 JSON 对象：

```json
{
  "schema": "gidd.doctor/v1",
  "status": "needs_setup",
  "repository": "D:\\work\\project",
  "checks": [
    { "id": "runtime", "status": "missing", "reason": "requires_node_or_bun", "details": { "depends_on": ["tool.node", "tool.bun"] } }
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
| `0` / `local_ready` | 平台、Git、至少一种运行时、gh、工作树、commit、remote、配置存在性及工具存储 schema 验证均通过 |
| `1` / `needs_setup` | 正常完成诊断，基础条件尚不齐备 |
| `2` / `error` | 调用参数错误或诊断程序无法完成；stderr 提供说明 |

检查项为 `platform`、`tools.storage`、`tool.git`、`tool.node`、`tool.bun`、`tool.gh`、`runtime`、`repository`、`repository.config`、`repository.config.validation`、`github.identity`、`git.authentication`。只有工作树可读取时才另有 `repository.history` 和 `repository.remotes`；没有 commit 的新仓库报告 `unborn_branch`。

`repository.config` 检查固定路径文件存在性；`repository.config.validation` 验证 [configuration.md](configuration.md) 的工具存储 schema v1。`tools.storage` 报告配置值与解析位置。配置错误时该项为 invalid，managed_tools_checked=false，仅继续外部 PATH 探测，不回退默认受管目录。source=managed 表示受管工具，实际位置以 tools.storage 为准。GitHub 身份与 Git 传输认证仍为 not_checked；local_ready 不代表仓库启用、账号正确或具备推送权限。

remote 检查只读取本地配置，不访问网络。只对常见 `https://github.com/owner/repo` 和 `git@github.com:owner/repo` 地址提取 `github_repository`；其他形式、其他主机或含凭据的 URL 返回 null，Agent 可另行检查，不据此认定 remote 无效。不会输出完整 URL 或子进程原始错误，避免泄露凭据。

## Agent 如何使用结果

- 用户说“当前仓库启用 GIDD”：先对明确的目标仓库诊断。已有运行时通过时直接复用，不要求同时安装 Node 和 Bun。
- `runtime` 缺失：解释需要运行时，并说明 GIDD 便携 Bun 的预期位置；用户已授权准备环境时，按 [setup.md](setup.md) 调用独立安装入口，doctor 自身不下载。
- `repository.config` 缺失：说明该仓库尚无固定位置配置，再按用户授权进入配置流程；不要用目录存在代替启用记录。
- `github.identity` 未检查：说明尚未检查，不能说“未登录”。用户要求检查当前账号时使用独立的 [身份检查入口](identity.md)，该入口会联网。需要登录时另行展示 URL 与一次性代码，当前 doctor 不启动登录。
- 初始化或修复后重新诊断。退出码 1 不是脚本崩溃；不要无条件重复执行或把结果当作自动安装授权。

doctor 自身不安装工具、不写目标仓库或工具目录、不切换账号、不写 Git 配置、不修改全局环境。它会执行找到的本机 executable 的版本查询，不能保证任意第三方 executable 本身没有副作用。
