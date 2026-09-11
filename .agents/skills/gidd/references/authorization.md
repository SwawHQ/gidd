# GitHub 设备授权

仅在用户明确要求登录/申请授权时调用。例如“帮这个仓库登录 GitHub，账号是 octocat”。先明确目标仓库、主机和预期账号；普通 doctor、身份检查及测试不得触发登录。

Windows 入口（可用 Node/Bun 任一种）：

```powershell
& "<目标仓库>\.agents\skills\gidd\gidd.cmd" auth
```

仓库内 `.agents/skills/gidd/` 的入口从自身位置自动定位目标（含 worktree），不依赖工作目录。主机与预期账号只读取仓库配置中的 `github.hostname` 和 `github.account`；缺失即报错，不临时覆盖或推断账号。`github.remote` 不参与授权，配置设置见 [configuration.md](configuration.md)。入口经 [bootstrap](bootstrap.md) 已发布的共享启动器直接执行 JS，再读取共享 gh 路径绑定；不搜索 PATH 或执行额外版本探测。启动器缺失时提示 tools --ensure，不自动准备运行时。缺失 gh 时由 Agent 根据用户授权使用 [工具准备入口](setup.md)。申请授权要求 gh 2.98.0 或更新版本，由 tools --ensure 验证并记录；原路径被外部替换可能需 doctor 检出。

业务逻辑使用 Node/Bun 共有标准 API；当前 CLI 平台验收仅为 Windows x64，其他平台启动/取消行为仍待测试，不宣称已支持。

## 流程与输出

1. 先请求 GitHub API 验证当前身份。匹配则返回 `already_authenticated`；已登录其他账号则返回 `existing_account_mismatch`，不自动切换或重新登录。
2. API 未验证成功且没有 token 环境变量覆盖时，启动 `gh auth login --hostname <host> --web --skip-ssh-key --clipboard=false`。stdin/stdout/stderr 都使用管道并关闭 stdin，设置 `GH_PROMPT_DISABLED=1`；gh 按非交互设备流程输出信息，不打开浏览器、不复制剪贴板、不配置 Git 凭据助手或上传 SSH 密钥。
3. 从同一进程的输出提取代码和同主机的 HTTPS `/login/device` URL。stderr 实时输出一行 `gidd.auth.event/v1` JSON：`type=authorization_required`、`url`、`code`。Agent 将 URL 和代码展示给用户，保留登录进程的有效工具会话，让用户在任意设备完成授权。
4. gh 等待授权并保存凭据后退出，脚本再次请求 API，实际账号与预期一致才报告 `authenticated`。不以用户说“好了”或 gh 退出 0 代替身份核验。

最终 stdout 为 `gidd.auth/v1` JSON。`status=ready` 退出 0；不匹配、拒绝/其他 gh 失败、取消、超时或核验失败退出 1；参数/启动错误退出 2。申请期间最多等待 15 分钟；各前后检查默认 15 秒。超时或取消会终止子进程，等待其退出，清理确认最多额外 500 毫秒；CLI 处理 SIGINT/SIGTERM，JavaScript 调用也支持 AbortSignal。强制杀死父进程不能视为已完成有序取消。

这是一次临时等待，不安装后台常驻服务。Agent 可以先展示代码，再在用户回复后读取同一进程结果；不能结束 gh 后期待另一个 `gh auth status` 续领原授权。过期后重新申请，不另存设备授权状态。非设备授权 URL、未观察到本次设备信息等情况明确失败。

## 凭据与边界

凭据交给 gh 的系统凭据存储管理；无法使用时 gh 可能回退到明文配置，脚本识别到提示会报告 `credential_storage=plaintext`，否则只报告 `managed_by_gh`，不推断具体后端。可以继承用户明确选定的 `GH_CONFIG_DIR`；该变量选择 gh 配置目录，不能视为与系统凭据库完全隔离。GIDD 不把 token、设备代码或登录结果写进 `config.toml`。

若存在 token 环境变量且身份无法验证，返回 `environment_token_active`；不暗中清空用户 token，也不绕过它去登录。身份已匹配时允许复用环境认证。

登录开始后的失败或账号不匹配可能发生在 gh 已保存凭据之后，因此结果标记 `credentials_may_have_changed=true`。Agent 应报告实际结果；不擅自 logout、删除凭据或回滚账号。成功仅确认 GitHub API 身份，Git 传输和 commit 作者仍通过 [doctor 诊断](doctor.md) 分别报告，不声称已能 push，也不启用仓库。

离线用例使用模拟 gh，不读取真实登录。已用真实 gh 2.98.0 在 Node/Bun 下验证设备信息输出和取消；维护者曾用当时的账号参数入口确认真实授权通过；当前入口改为配置读取，并通过模拟 gh 回归验证，未重新发起真实登录。该人工结果由维护者提供，具体凭据存储后端仍以 gh 的实际结果为准。

依据：[gh auth login](https://cli.github.com/manual/gh_auth_login)、[gh 2.98 非交互授权实现](https://github.com/cli/cli/blob/v2.98.0/internal/authflow/flow.go)、[GitHub 设备流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)。
