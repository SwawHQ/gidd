# GitHub 身份检查（Windows）

用户要求“检查此仓库的 GitHub 登录”时，Agent 先确定目标仓库和预期主机、账号，再调用 `gidd.cmd identity`。该命令会联网检查，但不启用仓库、不安装 gh、不发起登录或切换账号，不写入配置或 commit。

```powershell
& "<目标仓库>\.agents\skills\gidd\gidd.cmd" identity
```

仓库内 `.agents/skills/gidd/` 的入口从自身位置自动定位目标（含 worktree），不依赖工作目录。主机、预期账号和 remote 只读取仓库配置的 `github.hostname`、`github.account`、`github.remote`，三者均须存在；缺项时报错并提示 `config set`，运行时不补默认值。账号比较忽略大小写。旧的三个覆盖参数已移除，设置方式见 [configuration.md](configuration.md)。

入口经 [bootstrap](bootstrap.md) 已发布的共享启动器直接执行 JS，不调用 PowerShell。scripts/gidd.mjs 读取共享 tool-bindings.json，以绑定绝对路径调用 scripts/github.mjs；不搜索 PATH、执行版本探测或遍历工具目录，所有子调用复用绑定。绑定缺失或无法启动时提示 bootstrap，不自动回退重跑。所选 Git 目录只追加到子进程 PATH 最前，使 gh 使用同一 Git；安装与校验规则见 [setup.md](setup.md)。缺失 gh 不自动安装；启动器缺失时提示 bootstrap，身份检查尚未执行。

入口只使用实际 `.exe`，不依赖开发者私有包装命令。

## 结果

标准输出为 JSON，`schema = gidd.identity/v1`，各项独立报告：

| 检查 | 验证内容 |
| --- | --- |
| `github.api` | `gh api --hostname <host> --method GET user --jq .login` 实际返回的账号；与预期不一致为 `mismatch` |
| `repository` | 目标是可读取的 Git 工作树 |
| `git.author` | `git var GIT_AUTHOR_IDENT` 有效作者姓名和邮箱，包括当前进程的作者覆盖；不据此推断 GitHub 登录 |
| `git.remote_read` | 经 `insteadOf` 解析的远程为同一主机、无内嵌凭据的 HTTPS URL 时，尝试非交互 `git ls-remote`；空仓库无 HEAD 也可读取成功 |
| `git.authentication` | 始终 `not_checked`：远程可读不能证明 Git 使用的账号或推送权限 |

`checks_passed` / 退出 0 表示前四项都通过，仍不代表 Git 推送认证通过。失败、不匹配、依赖缺失或远程未检查为 `needs_attention` / 退出 1；参数、平台或启动错误为退出 2。API 请求失败可能是凭据、网络或服务问题，不直接判定“未登录”。错误输出仅保留原因码，不转发子进程 stderr、失败 stdout 或完整远程 URL。

当前仅验证 Windows x64、Windows PowerShell 5.1、Bun 1.4.2 与 Node 24。SSH、其他主机、带凭据或查询参数的远程不会进行传输探测，返回 `not_checked`；这不是认证失败。JS doctor 是离线诊断；普通启动不联网下载运行时。

每个业务子进程默认最多 15 秒，终止确认最多额外 500 毫秒，输出最多 1 MiB；一项失败后继续独立项。关闭 stdin，禁用 Git/GCM 的交互提示，不执行 `auth login`、`auth switch` 或 `auth setup-git`。继承调用进程选定的 gh 认证环境（包括 `GH_CONFIG_DIR` 和 token 环境变量），不读取或输出 token；Git 继续使用自身现有凭据配置。外部凭据助手自身的行为由该助手决定。

收到异常或账号不匹配后，Agent 报告事实并与用户明确后续操作。用户明确要求登录时使用独立的 [授权入口](authorization.md)，展示本次 URL 和一次性代码、抑制浏览器启动、等待用户授权并验证实际账号。检查成功不是仓库启用记录，也不授权创建 Issue/PR。

协议依据：[gh api](https://cli.github.com/manual/gh_api)、[git var](https://git-scm.com/docs/git-var)、[git ls-remote](https://git-scm.com/docs/git-ls-remote)。
