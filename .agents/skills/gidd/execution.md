# Git / GitHub command environment

`gidd.link .gh <args...>` and `gidd.link .git <args...>` start the bound tool in the entry's repository directory. They forward arguments, stdin, stdout, stderr and the exit code. They do not inspect target arguments, restrict repositories, switch the shared gh account, or write Git configuration. Explicit native options such as `--repo`, `-C`, `-c` and `--author` retain their normal meaning. These commands can perform writes when the forwarded command does so.

`gidd.link .gh.auth` is a separate authorization command. It reuses verified credentials for the configured account; if that account's token is unavailable, it starts device authorization, reports the URL/code and verifies the resulting account. Credentials are stored by gh. The `gidd.auth/v1` and `gidd.auth.event/v1` JSON formats are retained. The old `auth` entry is removed. `.gh.auth` does not forward to `.gh auth`: the `.gh` wrapper requires an existing verified token before executing native arguments.

Authorization reads the bound entry directory's `config.toml`, derives the host directly from `repo.remote.url`, and uses `repo.remote.account`. It requires valid URL/account fields and a compatible gh binding. It does not require Git, a `.git` worktree, `repo.remote.name`, local remote consistency, or completed Git identity/credential settings. The config file and binding record must still parse successfully. `doctor` retains local repository/remote diagnostics; authorization does not imply repository access or readiness. An existing token that fails identity verification returns an error instead of starting a new login.

## Configuration

Use these configuration commands in the entry's repository:

```text
gidd.link set.show
gidd.link set <key> <value>
gidd.link clear <key>
```

Bare `gidd.link set` displays the same localized main help as `gidd.link help`, without reading or modifying configuration, including when the file is missing or invalid. It uses the same language selection as help (`GIDD_LANG`, then locale). The `show` and `config` commands have been removed; `set show`, `del` and `delete` are not supported. Configuration results retain the `gidd.config/v1` JSON schema and doctor IDs retain the `config.` prefix.

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
current = "issue-direct"
```

`spec.current` is the explicit spec selection. `doctor` (including `--offline`) cannot pass when it is missing, unsupported, or its resources are damaged. For a missing/unsupported selection, its `config.spec.current` hint and commands guide three steps: `gidd.link spec.list` for summaries, `gidd.link spec.<name>` for full instructions, then `gidd.link set spec.current <name>` to select. Summaries help identify candidates; read the full instructions before choosing. The former `spec.mode` field is not accepted. `clear spec.current` removes the selection and doctor then reports it missing. Damaged resources require repair.

`gidd.link spec.list --lang en|zh` returns `{ "scope": "...", "specs": [{ "name": "...", "description": "..." }] }` even when repository configuration is absent or invalid. Names come from the skill root's `spec.<name>` directories, sorted by name; no separate registry is maintained. Each directory contains `description.json` with exactly two nonempty strings: `{ "en": "English summary", "zh-CN": "中文简介" }`. Every `spec.*` entry must be a plain directory with a lowercase name matching `[a-z][a-z0-9-]*`; `current` and `list` are reserved. An empty catalog, invalid directories or missing/invalid descriptions are errors. Listing, selection and doctor share this validation; selected-spec reads and doctor additionally validate both languages of the selected spec's prompts and Issue forms. The former root catalogs are removed.

Both Git modes are required and independent:

- `git.user.mode = "managed"` supplies the default commit identity from this file and requires both `user.name` and `user.email`.
- `git.user.mode = "inherit"` uses Git's existing identity rules and requires both name/email fields to be absent. Keeping either field is a configuration error. Here `managed` refers to identity defaults supplied by GIDD, independently of whether the Git executable is GIDD-managed.
- `git.credential.mode = "gh"` supplies gh-backed credentials for the configured HTTPS host; `inherit` leaves Git authentication unchanged.

No migration or implicit mode is provided. `set` and `clear` can repair one field at a time; complete the selected mode's requirements before invoking wrappers or `set.show`. No tokens are stored in this file.

`gidd.link clear <key>` removes the assignment for any field accepted by `set`, preserving other contents, BOM, line endings and comments (an inline comment becomes a standalone comment). Unknown fields are errors. An absent field succeeds without rewriting the file; an absent config file succeeds without creating a file or directory. The JSON result includes `action: "clear"`, `key` and `changed: true|false`, without the removed value. Required fields may be cleared; doctor and execution checks then report the incomplete configuration. Empty strings still undergo normal `set` validation and never mean removal. Clear uses the same configuration lock and atomic replacement protections as set.

To switch from managed to inherited identity:

```text
gidd.link clear git.user.name
gidd.link clear git.user.email
gidd.link set git.user.mode inherit
```

`doctor` reports the identity policy under `config.git.user.mode`, including `details.mode` and `details.source` (`config.toml` or `git`). Separate `config.git.user.name` and `config.git.user.email` checks report managed values in `details.configured`; in inherit mode, omitted fields are ready with `details.omitted: true`, while present fields are errors. An invalid mode blocks both field checks. `folder.git.author` reports the effective author and committer; invalid identity configuration blocks it with a reference to the first failing field instead of reporting an inherited fallback as ready.

## Execution and priority

- `.gh` derives `GH_HOST` and `GH_REPO` from `repo.remote.url`, obtains the saved token for the configured host/account, and verifies it via `api user`. Inherited gh target/token variables are replaced in this child environment. No `auth switch` occurs. Explicit gh targets may override the default repository; they do not change the identity of the supplied token.
- In `managed` identity mode, both entries apply configured `user.name/email` using ordered `GIT_CONFIG_COUNT` entries; `inherit` injects neither key. Managed values override the same keys in configuration files; explicit `git -c` settings override the injected configuration. Existing author/committer-specific configuration, environment variables, `--author`, and Git's preservation of original authors retain native semantics. Signing configuration is inherited.
- In `gh` mode, the configured HTTPS host's helper list is reset and replaced by a lazy helper. It selects and verifies the saved account token, then delegates the credential response to `gh auth git-credential`. Local Git commands do not acquire credentials or need a login. Missing credentials fail when requested; run `gidd.link .gh.auth` to authorize the configured account.
- SSH does not use the HTTPS helper. It retains native SSH authentication in both modes. `inherit` does not guarantee the push account. Other native authentication sources and explicit overrides retain Git semantics; this wrapper is not an authentication enforcement boundary.
- Git commands launched by gh normally inherit the same environment and selected Git path. Programs that replace that environment or pass their own configuration follow native rules; GIDD does not monitor or restrict descendants. Cancellation stops the launched command tree on Windows.
- `GH_REPO` does not redirect Git push. Git still selects its destination from remotes, branch settings and explicit arguments. `doctor` diagnoses configured remote consistency and effective identity; execution does not reject intentional target overrides.
- Internal token acquisition is captured privately and diagnostics do not print tokens. Forwarded commands preserve their native output, including credential output if that is what the caller explicitly requests.

## 中文摘要

当前规范配置为 `[spec]` 下的 `current = "issue-direct"`，设置命令为 `gidd.link set spec.current <名称>`，旧 `spec.mode` 字段不再接受。doctor（含离线模式）的 `config.spec.current` 检查要求显式选择有效规范，且相关资源完整；未选或选择无效时，提示和命令依次引导：运行 `spec.list` 查看简介，运行 `spec.<名称>` 阅读全文，最后设置 `spec.current`。简介用于初步识别，选择前应阅读全文。`clear spec.current` 会移除选择，之后 doctor 报告缺失；资源损坏时提示修复。

`spec.list` 根据语言返回 `scope` 和包含 `name`、`description` 的 `specs` 数组，不依赖仓库配置有效。规范名称来自技能根目录的 `spec.<名称>`，按名称排序，不再另建名称清单。各目录下的 `description.json` 只包含 `en`、`zh-CN` 两个非空字符串。所有 `spec.*` 项必须是普通目录，名称符合小写 `[a-z][a-z0-9-]*`，不得使用保留名 `current/list`；未发现规范目录、名称或目录类型无效、描述缺失或无效均报错。列表、设置和 doctor 共用这些校验；读取已选规范及 doctor 还会校验该规范两种语言的正文和 Issue 表单。原有根目录双语清单已移除。

`gidd.link .gh.auth` 是独立授权入口：复用配置账号已核验的凭据；取不到该账号的 token 时发起设备授权，输出网址和设备码，完成后核验账号，凭据由 gh 保存。保留 `gidd.auth/v1` 和 `gidd.auth.event/v1` JSON 格式，旧 `auth` 入口移除。它不转发为 `.gh auth`；`.gh` 包装在执行原生参数前要求已有可验证的 token。

授权读取入口绑定目录的 `config.toml`，直接从 `repo.remote.url` 提取主机，使用 `repo.remote.account` 指定账号；仅要求 URL/account 字段有效及 gh 绑定版本符合要求。不要求 Git、`.git` 工作区、`repo.remote.name`、本地远端地址一致或 Git 身份/凭据配置完整；配置文件和工具绑定记录仍须能正常解析。doctor 继续诊断本地仓库及远端，授权成功不代表仓库访问权限或就绪状态。已有 token 核验失败时直接报告错误，不自动重新登录。

配置命令为 `gidd.link set.show`、`gidd.link set <字段> <值>`、`gidd.link clear <字段>`。不带参数的 `gidd.link set` 显示与 `gidd.link help` 相同的本地化主帮助，不读取或修改配置，配置缺失或损坏时也可查看；语言选择与 help 一致（优先 `GIDD_LANG`，再按系统语言）。旧 `show` 和 `config` 入口已移除，不支持 `set show`、`del` 或 `delete`。配置结果仍使用 `gidd.config/v1` JSON 格式，doctor 的 `config.` 字段 ID 保持不变。

两入口提供默认环境，显式参数交给 Git/gh 处理。`git.user.mode` 必须填写 `managed` 或 `inherit`：前者要求姓名和邮箱两项必填，后者要求两项均省略；缺失模式或冲突配置均报错。独立的 `git.credential.mode` 必须填写 `gh` 或 `inherit`。`.gh` 从配置 URL 设置默认 host/repo，并使用指定账号已保存的 token；`.git` 在 managed 模式下用环境配置覆盖同名文件配置，保留 `-c`、`--author`、历史作者及签名的原生语义。

`set` 和 `clear` 允许逐字段修复；`.git` / `.gh` 包装和 `set.show` 要求配置完整。切换为 inherit 时，先执行 `clear git.user.name`、`clear git.user.email`，再执行 `set git.user.mode inherit`。clear 删除赋值，不写入空字符串；字段已不存在则成功且不重写配置，配置文件不存在也不会创建文件或目录。未知字段报错；必填字段允许清除，之后由 doctor/执行入口报告缺失。保留其余内容、BOM、换行和注释，行内注释转为独立注释，沿用 set 的文件锁和原子替换保护；结果以 `changed` 表示是否修改。

doctor 的 `config.git.user.mode` 报告模式和来源，`config.git.user.name`、`config.git.user.email` 分别检查对应字段：managed 下报告配置值，inherit 下省略为正常、填写为冲突。模式无效时，姓名和邮箱检查受阻并指向模式项；`folder.git.author` 报告实际生效身份，署名配置无效时指向首个失败字段，不将回退身份误报为就绪。

`gh` 模式仅为指定 HTTPS host 配置按需认证助手，不禁止 SSH。Git 本地操作不需要登录；缺少凭据时，在实际请求凭据的阶段失败。两入口不会限制跨仓库参数，也不修改全局身份或切换共享活动账号。`doctor` 用于诊断配置和实际生效身份，不能证明推送账号或权限。
