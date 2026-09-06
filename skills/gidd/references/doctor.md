# Windows 基础诊断

入口：`scripts/windows/doctor.ps1`。当前验证平台为 Windows x64、Windows PowerShell 5.1；不要求先安装 Bun、Node 或 gh。

从实际技能安装目录执行，例如：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\windows\doctor.ps1 -RepositoryPath 'D:\work\project' -UserSkillsRoot 'C:\Users\alice\.agents\skills'
```

两个参数均为必需的绝对路径。Agent 根据用户指定项目和客户端实际技能目录传入，不将技能源码目录当作目标仓库；Shell 不展开的 `~` 须由调用方展开。目标可以是仓库子目录，配置始终在 Git 返回的仓库根下查找。用户技能目录可以尚未存在，doctor 不建立它。

## 源码归属

`scripts/windows/doctor.ps1` 负责参数、显式加载、组合检查与 JSON/退出码；`scripts/windows/doctor/` 是其私有实现目录：

| 文件 | 职责 |
| --- | --- |
| `platform.ps1` | Windows 平台与架构 |
| `tools.ps1` | executable 候选、版本检查及 Node/Bun 选择 |
| `repository.ps1` | Git 工作树、commit、remote |
| `configuration.ps1` | 仓库配置文件存在性及验证状态 |
| `_process.ps1` | 上述检查使用的子进程启动、输出捕获、超时 |

这些 `.ps1` 文件由入口 dot-source 加载，不是独立命令或 `.psm1` 模块。领域检查按职责命名；以下划线开头的 `_process.ps1` 表示内部执行辅助，不代表一个检查领域。下划线只是项目命名约定，不具有 PowerShell 访问控制语义。新增领域检查在该目录实现并由入口显式调用，不扫描目录自动执行。`_process.ps1` 当前没有其他命令调用，出现真实跨命令复用需求时再考虑移入公共目录。

## 工具选择

依次检查 PATH 中的同名 `.exe`，失败后尝试 GIDD 共享工具。仅执行 `--version`，每个子进程最多等待 5 秒，stdin 关闭。首版不运行 `.cmd` 包装器，不修改 PATH。

进程退出和 stdout/stderr 读取共用同一个 5 秒期限；父进程退出后，后代仍持有输出管道时也会返回 `process_timeout`，不会重新开始计时或无限等待。辅助函数不负责终止所有后代进程。

| 工具 | 基础版本门槛 | PATH 后的候选 |
| --- | --- | --- |
| Git | 2.0 | 无 |
| Node.js | 22.0 | 无；复用已有 Node |
| Bun | 1.2 | `<用户技能根>/gidd.tools/bun/bun.exe` |
| gh | 2.0 | `<用户技能根>/gidd.tools/gh/gh.exe` |

Node 和 Bun 任一种可用即可满足 `runtime`。PATH 中可用运行时优先于共享工具；来源相同时优先 Bun。`tool.node` 缺失而 Bun 可用，不阻止总体本地就绪。拒绝的候选及原因保留在 `details.rejected`。

上述版本是诊断门槛，不证明所有对应版本的未来业务兼容性。JavaScript 业务代码须使用 Node/Bun 共同支持的标准 API，同一功能在两者上验证；当前 doctor 不执行 JavaScript 业务代码。

## 输出与退出码

stdout 为单个 UTF-8 JSON 对象：

```json
{
  "schema": "gidd.doctor/v1",
  "status": "needs_setup",
  "repository": "D:\\work\\project",
  "user_skills_root": "C:\\Users\\alice\\.agents\\skills",
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
| `0` / `local_ready` | 平台、Git、至少一种运行时、gh、工作树、commit、remote 和配置文件存在性均通过 |
| `1` / `needs_setup` | 正常完成诊断，基础条件尚不齐备 |
| `2` / `error` | 调用参数错误或诊断程序无法完成；stderr 提供说明 |

检查项为 `platform`、`tool.git`、`tool.node`、`tool.bun`、`tool.gh`、`runtime`、`repository`、`repository.config`、`repository.config.validation`、`github.identity`、`git.authentication`。只有工作树可读取时才另有 `repository.history` 和 `repository.remotes`；没有 commit 的新仓库报告 `unborn_branch`。

`repository.config` 仅检查 `<仓库根>/.agents/skills/gidd/config.toml` 是文件，不读取 TOML。配置验证、GitHub 身份及 Git 传输认证始终为 `not_checked`。`local_ready` 不代表配置有效、仓库已启用、账号正确或具备推送权限。

remote 检查只读取本地配置，不访问网络。只对常见 `https://github.com/owner/repo` 和 `git@github.com:owner/repo` 地址提取 `github_repository`；其他形式、其他主机或含凭据的 URL 返回 null，Agent 可另行检查，不据此认定 remote 无效。不会输出完整 URL 或子进程原始错误，避免泄露凭据。

## Agent 如何使用结果

- 用户说“当前仓库启用 GIDD”：先对明确的目标仓库诊断。已有运行时通过时直接复用，不要求同时安装 Node 和 Bun。
- `runtime` 缺失：解释需要运行时，并说明 GIDD 便携 Bun 的预期位置；下载初始化属于后续独立操作，当前脚本没有下载功能。
- `repository.config` 缺失：说明该仓库尚无固定位置配置，再按用户授权进入配置流程；不要用目录存在代替启用记录。
- `github.identity` 未检查：说明尚未检查，不能说“未登录”。需要认证时由独立流程展示 URL 与一次性代码，当前 doctor 不启动登录。
- 初始化或修复后重新诊断。退出码 1 不是脚本崩溃；不要无条件重复执行或把结果当作自动安装授权。

doctor 自身不安装工具、不写目标仓库或工具目录、不切换账号、不写 Git 配置、不修改全局环境。它会执行找到的本机 executable 的版本查询，不能保证任意第三方 executable 本身没有副作用。
