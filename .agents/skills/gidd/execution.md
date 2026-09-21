# Git / GitHub command environment

`gidd.link .gh <args...>` and `gidd.link .git <args...>` start the bound tool in the entry's repository directory. They forward arguments, stdin, stdout, stderr and the exit code. They do not inspect target arguments, restrict repositories, switch the shared gh account, or write Git configuration. Explicit native options such as `--repo`, `-C`, `-c` and `--author` retain their normal meaning. These commands can perform writes when the forwarded command does so.

The wrappers disable common interaction: Git/gh editors fail with a diagnostic, pagers print directly, and Git terminal/AskPass and GCM credential prompts are disabled. Explicit Git patch/interactive modes for add, clean, commit, checkout, restore, reset and stash, plus mergetool/difftool/gui/citool, fail before execution; interactive rebase fails when it needs its editor. Supply messages, files and required arguments. Piped input remains available, including `commit -F -` and gh file/stdin inputs. The shared tool launchers do not apply this repository policy.

SSH keeps the selected command, key/proxy options and transport working directory, adding OpenSSH `BatchMode=yes` or PuTTY `-batch`. Custom commands must identify their dialect through `ssh.variant` or `GIT_SSH_VARIANT` when it cannot be inferred as `ssh`; unsupported variants fail. SSH configuration is resolved in the actual Git transport, including `-C`, `-c` and submodules.

These defaults are not a sandbox for hooks, aliases, extensions, signing agents or arbitrary external programs. They cannot guarantee that such programs never wait or override the defaults, and do not bypass signing or hooks. Set `GIDD_EXEC_TIMEOUT_MS` to an optional command deadline in milliseconds (unset or `0`: unlimited). It starts when the forwarded command launches, after credential preflight; timeout stops the command tree on Windows and returns 124. Cancellation returns 130. `.gh.auth` retains its separate device-authorization deadline.

Git for Windows file-access retry confirmations are also declined; resolve the locked file before retrying the operation.

`gidd.link .gh.auth` is a separate authorization command. It reuses verified credentials for the configured account; if that account's token is unavailable, it starts device authorization, reports the URL/code and verifies the resulting account. Credentials are stored by gh. The `gidd.auth/v1` and `gidd.auth.event/v1` JSON formats are retained. The old `auth` entry is removed. `.gh.auth` does not forward to `.gh auth`: the `.gh` wrapper requires an existing verified token before executing native arguments.

Authorization reads the bound entry directory's `config.toml`, derives the host directly from `repo.remote.url`, and uses `repo.remote.account`. It requires valid URL/account fields and a compatible gh binding. It does not require Git, a `.git` worktree, `repo.remote.name`, local remote consistency, or completed Git identity/credential settings. The config file and binding record must still parse successfully. `doctor` retains local repository/remote diagnostics; authorization does not imply repository access or readiness. An existing token that fails identity verification returns an error instead of starting a new login.

## Configuration

Use these configuration commands in the entry's repository:

```text
gidd.link set.show
gidd.link set <key> <value>
gidd.link clear <key>
```

Bare `gidd.link set` displays the same localized main help as `gidd.link help`, without reading or modifying configuration, including when the file is missing or invalid. It uses the same language selection as help (`GIDD_LANG`, then locale). The `show` and `config` commands have been removed; `set show`, `del` and `delete` are not supported. `set.show` writes the original TOML directly to stdout, preserving comments, BOM and line endings without adding a newline. It does not parse or validate configuration, so incomplete or malformed TOML remains readable. Missing files or read errors produce stderr diagnostics and a nonzero exit code; file type, path, UTF-8 and size checks still apply. `set` and `clear` results retain the `gidd.config/v1` JSON schema and doctor IDs retain the `config.` prefix.

```toml
schema_version = 1

[repo]
remote.name = "origin"
remote.url = "https://github.com/owner/repo"
remote.account = "your-login"

[git]
user.mode = "managed"
user.name = "Commit Name"
user.email = "name@example.com"
credential.mode = "gh"

[spec]
current = "04.issue.ask-commit"
```

`spec.current` is the explicit spec selection. `doctor` (including `--offline`) cannot pass when it is missing, unsupported, or its resources are damaged. For a missing/unsupported selection, its `config.spec.current` hint and commands guide three steps: `gidd.link spec.list` for summaries, `gidd.link spec <name>` for full instructions, then `gidd.link set spec.current <name>` to select. Summaries help identify candidates; read the full instructions before choosing. The former `spec.mode` field is not accepted. `clear spec.current` removes the selection and doctor then reports it missing. Damaged resources require repair.

`spec.list --lang en|zh` returns `scope` and `specs`, sorted by full spec name. Each entry has `name` and a `description` array of six single-key objects, preserving source order. Both prompt languages must use identical keys, values and order. `spec <name>` and `spec.current` print the workflow body; `spec.issue <name>` and `spec.issue.current` return its declared JSON form. See [spec authoring](specs/AGENTS.md) for entry metadata, includes and template-command replacement.

Both Git modes are required and independent:

- `git.user.mode = "managed"` supplies the default commit identity from this file and requires both `user.name` and `user.email`.
- `git.user.mode = "inherit"` uses Git's existing identity rules and requires both name/email fields to be absent. Keeping either field is a configuration error. Here `managed` refers to identity defaults supplied by GIDD, independently of whether the Git executable is GIDD-managed.
- `git.credential.mode = "gh"` supplies gh-backed credentials for the configured HTTPS host; `inherit` keeps Git's credential sources. Both modes disable common credential prompts.

No migration or implicit mode is provided. `set` and `clear` can repair one field at a time; complete the selected mode's requirements before invoking wrappers. No tokens are stored in this file.

`gidd.link clear <key>` removes the assignment for any field accepted by `set`, preserving other contents, BOM, line endings and comments (an inline comment becomes a standalone comment). Unknown fields are errors. An absent field succeeds without rewriting the file; an absent config file succeeds without creating a file or directory. The JSON result includes `action: "clear"`, `key` and `changed: true|false`, without the removed value. Required fields may be cleared; doctor and execution checks then report the incomplete configuration. Empty strings still undergo normal `set` validation and never mean removal. Clear uses the same configuration lock and atomic replacement protections as set.

To switch from managed to inherited identity:

```text
gidd.link clear git.user.name
gidd.link clear git.user.email
gidd.link set git.user.mode inherit
```

`doctor` reports the identity policy under `config.git.user.mode`, including `details.mode` and `details.source` (`config.toml` or `git`). Separate `config.git.user.name` and `config.git.user.email` checks report managed values in `details.configured`; in inherit mode, omitted fields are ready with `details.omitted: true`, while present fields are errors. An invalid mode blocks both field checks. `folder.git.identity` reports the current effective identities under `details.author` and `details.committer`, each with `name` and `email`. Both Git identity probes must succeed for this check to be ready. These are current execution defaults, not a historical commit or a guarantee that a future commit will succeed; invalid identity configuration blocks it with a reference to the first failing field instead of reporting an inherited fallback as ready.

## Execution and priority

- `.gh` derives `GH_HOST` and `GH_REPO` from `repo.remote.url`, obtains the saved token for the configured host/account, and verifies it via `api user`. Inherited gh target/token variables are replaced in this child environment. No `auth switch` occurs. Explicit gh targets may override the default repository; they do not change the identity of the supplied token.
- In `managed` identity mode, both entries apply configured `user.name/email` using ordered `GIT_CONFIG_COUNT` entries; `inherit` injects neither key. Managed values override the same keys in configuration files; explicit `git -c` settings override the injected configuration. Existing author/committer-specific configuration, environment variables, `--author`, and Git's preservation of original authors retain native semantics. Signing configuration is inherited.
- In `gh` mode, the configured HTTPS host's helper list is reset and replaced by a lazy helper. It selects and verifies the saved account token, then delegates the credential response to `gh auth git-credential`. Local Git commands do not acquire credentials or need a login. Missing credentials fail when requested; run `gidd.link .gh.auth` to authorize the configured account.
- SSH does not use the HTTPS helper. Both modes retain SSH credential sources with batch interaction disabled as described above. `inherit` does not guarantee the push account. Other native authentication sources and explicit overrides retain Git semantics; this wrapper is not an authentication enforcement boundary.
- Git commands launched by gh normally inherit the same environment and selected Git path. Programs that replace that environment or pass their own configuration follow native rules; GIDD does not monitor or restrict descendants. Cancellation stops the launched command tree on Windows.
- `GH_REPO` does not redirect Git push. Git still selects its destination from remotes, branch settings and explicit arguments. `doctor` diagnoses configured remote consistency and effective identity; execution does not reject intentional target overrides.
- Internal token acquisition is captured privately and diagnostics do not print tokens. Forwarded commands preserve their native output, including credential output if that is what the caller explicitly requests.

## 中文摘要

`.git` / `.gh` 禁用常见交互：编辑器直接报错、分页直接输出、禁止 Git 终端/AskPass 和 GCM 凭据询问；add、clean、commit、checkout、restore、reset、stash 的显式交互/补丁模式，以及 mergetool/difftool/gui/citool 直接失败。正常管道输入保留，请用参数或文件提供消息和必要数据。SSH 保留原命令及密钥/代理配置，追加 OpenSSH `BatchMode=yes` 或 PuTTY `-batch`；无法识别的自定义命令须声明 `ssh.variant` 或 `GIT_SSH_VARIANT`，不支持的变体报错。

hooks、alias、扩展、签名代理及任意外部程序可能自行等待或覆盖默认值，包装不是沙箱，也不会跳过签名或 hooks。可设置 `GIDD_EXEC_TIMEOUT_MS`（毫秒；未设置或 0 表示不限时），从实际转发命令启动时计时，超时终止 Windows 命令进程树并退出 124；取消退出 130。`.gh.auth` 保留独立设备授权及其超时。共享工具启动器不应用这些仓库包装策略。

Git for Windows 遇到文件占用时也不询问是否重试；先解决文件访问问题，再重新执行命令。

当前规范配置为 `[spec]` 下的 `current = "04.issue.ask-commit"`，设置命令为 `gidd.link set spec.current <名称>`，旧 `spec.mode` 字段不再接受。doctor（含离线模式）的 `config.spec.current` 检查要求显式选择有效规范，且相关资源完整；未选或选择无效时，提示和命令依次引导：运行 `spec.list` 查看简介，运行 `spec <名称>` 阅读全文，最后设置 `spec.current`。简介用于初步识别，选择前应阅读全文。`clear spec.current` 会移除选择，之后 doctor 报告缺失；资源损坏时提示修复。

`spec.list` 按完整规范名排序返回 `scope` 和 `specs`，每项含 `name` 和由六个单键对象组成的 `description` 数组，保留源文件顺序；双语的键、值及顺序必须一致。`spec <名称>`、`spec.current` 打印流程正文；`spec.issue <名称>`、`spec.issue.current` 返回所声明的 JSON 表单。入口元数据、include 和模板命令替换见 [规范编写](specs/AGENTS.md)。

`gidd.link .gh.auth` 是独立授权入口：复用配置账号已核验的凭据；取不到该账号的 token 时发起设备授权，输出网址和设备码，完成后核验账号，凭据由 gh 保存。保留 `gidd.auth/v1` 和 `gidd.auth.event/v1` JSON 格式，旧 `auth` 入口移除。它不转发为 `.gh auth`；`.gh` 包装在执行原生参数前要求已有可验证的 token。

授权读取入口绑定目录的 `config.toml`，直接从 `repo.remote.url` 提取主机，使用 `repo.remote.account` 指定账号；仅要求 URL/account 字段有效及 gh 绑定版本符合要求。不要求 Git、`.git` 工作区、`repo.remote.name`、本地远端地址一致或 Git 身份/凭据配置完整；配置文件和工具绑定记录仍须能正常解析。doctor 继续诊断本地仓库及远端，授权成功不代表仓库访问权限或就绪状态。已有 token 核验失败时直接报告错误，不自动重新登录。

配置命令为 `gidd.link set.show`、`gidd.link set <字段> <值>`、`gidd.link clear <字段>`。不带参数的 `gidd.link set` 显示与 `gidd.link help` 相同的本地化主帮助，不读取或修改配置，配置缺失或损坏时也可查看；语言选择与 help 一致（优先 `GIDD_LANG`，再按系统语言）。旧 `show` 和 `config` 入口已移除，不支持 `set show`、`del` 或 `delete`。`set.show` 向 stdout 原样输出 TOML，保留注释、BOM 和换行，不额外追加换行；不解析或校验配置，不完整或有语法错误时也能查看。文件不存在或读取失败时向 stderr 输出诊断并返回非零退出码；仍检查文件类型、路径、UTF-8 和大小。`set`、`clear` 结果仍使用 `gidd.config/v1` JSON 格式，doctor 的 `config.` 字段 ID 保持不变。

两入口提供默认环境，显式参数交给 Git/gh 处理。`git.user.mode` 必须填写 `managed` 或 `inherit`：前者要求姓名和邮箱两项必填，后者要求两项均省略；缺失模式或冲突配置均报错。独立的 `git.credential.mode` 必须填写 `gh` 或 `inherit`。`.gh` 从配置 URL 设置默认 host/repo，并使用指定账号已保存的 token；`.git` 在 managed 模式下用环境配置覆盖同名文件配置，保留 `-c`、`--author`、历史作者及签名的原生语义。

`set` 和 `clear` 允许逐字段修复；`.git` / `.gh` 包装要求配置完整。切换为 inherit 时，先执行 `clear git.user.name`、`clear git.user.email`，再执行 `set git.user.mode inherit`。clear 删除赋值，不写入空字符串；字段已不存在则成功且不重写配置，配置文件不存在也不会创建文件或目录。未知字段报错；必填字段允许清除，之后由 doctor/执行入口报告缺失。保留其余内容、BOM、换行和注释，行内注释转为独立注释，沿用 set 的文件锁和原子替换保护；结果以 `changed` 表示是否修改。

doctor 的 `config.git.user.mode` 报告模式和来源，`config.git.user.name`、`config.git.user.email` 分别检查对应字段：managed 下报告配置值，inherit 下省略为正常、填写为冲突。模式无效时，姓名和邮箱检查受阻并指向模式项；`folder.git.identity` 在 `details.author`、`details.committer` 中分别报告当前生效的作者、提交者姓名和邮箱，两项探测均成功才为 ready。这是当前执行环境的身份，不代表历史提交，也不保证后续提交必定成功；署名配置无效时指向首个失败字段，不将回退身份误报为就绪。

`gh` 模式仅为指定 HTTPS host 配置按需认证助手，不禁止 SSH。Git 本地操作不需要登录；缺少凭据时，在实际请求凭据的阶段失败。两入口不会限制跨仓库参数，也不修改全局身份或切换共享活动账号。`doctor` 用于诊断配置和实际生效身份，不能证明推送账号或权限。
