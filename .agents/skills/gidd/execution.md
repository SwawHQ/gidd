# Git / GitHub command environment

`gidd.link .gh <args...>` and `gidd.link .git <args...>` read configuration from the entry's repository and start the bound tool in the caller's directory, preserving relative file paths. The caller must be in that repository or a related worktree registered by `workflow.workspace`; ordinary subdirectories are allowed. Other repositories, nested repositories/submodules, unregistered worktrees and non-repository directories fail before forwarding or acquiring a GitHub token. There is no fallback directory or force entry. Errors report the caller directory, detected repository, bound repository and configuration path.

Only the caller's directory is checked. Explicit Git locations (`-C`, `--git-dir`, `--work-tree`) and gh targets such as `--repo` follow native semantics and may select another repository, including for writes. The caller is responsible for that scope; the original entry's identity and credential settings still apply, without loading the selected repository's GIDD configuration. Inherited Git directory/index overrides are cleared. Arguments, stdin, stdout, stderr and native exit codes are otherwise forwarded. `doctor`, configuration and worktree management commands retain their entry-bound scope.

The wrappers disable common interaction: Git/gh editors fail with a diagnostic, pagers print directly, and Git terminal/AskPass and GCM credential prompts are disabled. Explicit Git patch/interactive modes for add, clean, commit, checkout, restore, reset and stash, plus mergetool/difftool/gui/citool, fail before execution; interactive rebase fails when it needs its editor. Supply messages, files and required arguments. Piped input remains available, including `commit -F -` and gh file/stdin inputs. The shared tool launchers do not apply this repository policy.

SSH keeps the selected command, key/proxy options and transport working directory, adding OpenSSH `BatchMode=yes` or PuTTY `-batch`. Custom commands must identify their dialect through `ssh.variant` or `GIT_SSH_VARIANT` when it cannot be inferred as `ssh`; unsupported variants fail. SSH configuration is resolved in the actual Git transport, including `-C`, `-c` and submodules.

These defaults are not a sandbox for hooks, aliases, extensions, signing agents or arbitrary external programs. They cannot guarantee that such programs never wait or override the defaults, and do not bypass signing or hooks. Set `GIDD_EXEC_TIMEOUT_MS` to an optional command deadline in milliseconds (unset or `0`: unlimited). It starts when the forwarded command launches, after credential preflight; timeout stops the command tree on Windows and returns 124. Cancellation returns 130. `.gh.auth` retains its separate device-authorization deadline.

Git for Windows file-access retry confirmations are also declined; resolve the locked file before retrying the operation.

`gidd.link .gh.auth` is a separate authorization command. It reuses verified credentials for the configured account; if that account's token is unavailable, it starts device authorization, reports the URL/code and verifies the resulting account. Credentials are stored by gh. The `gidd.auth/v1` and `gidd.auth.event/v1` JSON formats are retained. The old `auth` entry is removed. `.gh.auth` does not forward to `.gh auth`: the `.gh` wrapper requires an existing verified token before executing native arguments.

Authorization reads the bound entry directory's `config.toml`, derives the host directly from `repo.remote.url`, and uses `repo.remote.account`. It requires valid URL/account fields and a compatible gh binding. It does not require Git, a `.git` worktree, `repo.remote.name`, local remote consistency, or completed Git identity/credential settings. The config file and binding record must still parse successfully. `doctor` retains local repository/remote diagnostics; authorization does not imply repository access or readiness. An existing token that fails identity verification returns an error instead of starting a new login.

## Workflow and worktree management

`gidd.pre.ensure --repo` invokes `gidd.link init` after preparing tools and the repository entry. Initialization prepares the fixed `<repository>.gidd` directory and preserves existing configuration and resources on repeat; it does not choose identity modes or a spec. It checks GIDD worktree paths and records before creating data. Initialization failures can be retried with `gidd.link init`; see [local data](references/data.md). Preparation's `--check` and `--tools-only` do not initialize repository data.

`workflow.workspace <issue>` reads the Issue's GIDD configuration and records its number, delivery mode, branches, starting commit and configured remote locally. Direct commit requires the recorded target to be checked out in the entry repository. Merge modes create the specified new development branch and allocate a dedicated worktree; PR mode also checks the remote branches. Released directories can be reused. See [Issue and local records](references/data.md) for the configuration block.

`workflow.workspace --resume <issue>` verifies the existing local workspace against the current Issue configuration. Every workflow command requires an Issue number and reads the Issue through the configured GitHub account; a branch, path or omitted argument cannot select a task. Changed delivery settings, ambiguous bindings and released workspaces require inspection. Resume does not claim an agent session or create missing resources. Changing `spec.current` does not change recorded delivery settings; authorization still belongs to the selected spec and caller.

`workflow.push <issue>` pushes the target branch for direct delivery and the development branch for PR delivery. It publishes that branch's captured commit to its same-named remote branch, without force, other branches or tags. Direct merge first requires the target to contain the development tip.

`workflow.merge <issue>` performs local merging for direct-merge mode, or discovers and merges the matching PR for PR mode. Local merges preserve conflicts for manual resolution. An unoccupied target ref may be fast-forwarded; a divergent target must be checked out before merging. PR merges require a unique match and the exact local development commit, pass that SHA to GitHub and verify the merged result. The default method is merge; PRs also accept `--squash` or `--rebase`. `--message <title>` supplies a merge/squash title. Branch protection, pending checks or queues remain blockers; the command does not bypass them or claim delivery while waiting.

`workflow.target-sync <issue>` verifies PR delivery and fast-forwards the local target in its checkout, or updates an unoccupied ref using an expected old commit. Dirty, interrupted or divergent targets remain intact. An already synchronized target is unchanged.

`workflow.cleanup <issue>` verifies delivery before changing resources. Direct modes verify the remote target contains the local target tip. Direct commit then deletes only its local context, retaining the branch and files. Dedicated workspaces delete the delivered development branch and release their directories; PR mode also verifies local target synchronization and deletes the matching remote development branch with an exact commit lease. Failures retain progress and report a retry command with the Issue number, even after branch deletion. File preservation and process shutdown remain the caller's responsibility.

`worktree.list` summarizes other worktrees, omitting the entry checkout already identified by `target.repository`. Each row contains `issue.number` when recorded, `delivery_mode`, `target.branch`, `worktree.path/state/development_branch/checked_out_branch`, plus diagnostic `reason` when present; null/undefined values and empty groups are omitted. Unregistered worktrees and missing registered directories remain visible. Show and resume include actual `worktree.head/checked_out_branch`; Git flags appear in `worktree` only when true. A missing directory retains recorded context and `reason: "worktree_missing"`, with actual Git fields omitted. Show also reports cleanup evidence (`cleanup`) and `worktree.release_commit` when present, without repeating the raw record or internal workspace ID. Recorded `worktree.development_branch` remains distinct from actual `worktree.checked_out_branch`.

Show/remove resolve absolute or relative paths to registered worktree roots, with no branch-name or UUID fallback. `worktree.remove <path>` accepts only a released directory without files needing preservation and explicitly protects the entry's target repository checkout.

Workflow/worktree JSON keeps command results (`schema`, `status: "success"|"error"`, `reason`, `hint` and operation outcomes) at the top level, alongside `issue` (`number`, `url`) and `delivery_mode`. Context uses `target` and `worktree`, with unavailable groups omitted. `worktree.state` is GIDD's management state (`current`, `unreleased`, `available`, `needs_check`, `unmanaged`); `unreleased` does not identify an active session. `worktree.path` also applies to the entry checkout used for direct commit. Resume verifies continuation conditions; show inspects context and checkout state. Target sync reports the resulting target commit as `target.head`, not the development checkout's `worktree.head`. `target.remote.name/url` correspond to preparation-time `repo.remote.name/url`, with the URL normalized. Public output has no `workflow` object; internal records keep delivery context separately.

Dedicated records live under `<repository>.gidd/state/worktrees/`; current-workspace contexts live under `<repository>.gidd/state/workflows/`. Records retain stable worktree IDs; checkout paths are derived from the fixed directory rather than duplicated in each record. Context contains mode, remote identity, branches and starting commit, plus the Issue number, without task history or session ownership. The command lock lives beside the main checkout's configuration; a lock is reclaimed only when its recorded process is no longer running. Reuse replaces old context. A changed remote name/identity or unexpected branch requires inspection rather than silently changing delivery targets. Workflow results use `gidd.workflow/v1`; worktree queries retain `gidd.worktree/v1`. Allocation does not install another entry or copy configuration. Use the original entry from allowed caller directories. See [local data](references/data.md) for inspection and maintenance.

Call the original configured entry from the dedicated worktree for Git/GitHub operations, preserving the entry's configuration. From an allowed directory, `.git -C <worktree-path> ...` can also select a registered worktree. Specify the development and target branches explicitly when creating a PR (`--head` and `--base`).

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
current = "00/04.ask-commit"
```

`spec.current` selects `<mode-id>/<name>` explicitly; mode IDs come from the two-digit directory prefixes (initially 00–02), not list positions or a second mapping in TOML/code. Full directory names and unprefixed mode names are also accepted. `doctor` (including `--offline`) checks directory naming and unique mode IDs/names, then requires a valid selection with complete dependencies in at least one language; it reports `resolved` and `available_languages`; duplicate directories appear in `details.conflicts`. Browse with `gidd.link spec.modes` and `gidd.link spec.list <mode-id>`, read `gidd.link spec <mode-id>/<name>`, then select with `gidd.link set spec.current <mode-id>/<name>`. `clear spec.current` removes the selection, which doctor then reports missing.

`spec.modes` reports each mode's `name` (the directory name including its numeric prefix), `description` and `specs` (the number of available specs). `spec.list <mode-id>` lists each preset with only `name` and `authorization`; unfinished or invalid presets include `error`. Availability means at least one complete language. `spec <mode-id>/<name>` and `spec.current` generate the mode description, flow, authorization and matching reference guidance. These commands require the requested language to be complete, without a mixed-language fallback. All spec commands accept `--lang en|zh`. `spec.issue <mode-id>/<name>` and `spec.issue.current` print the relative JSON template declared by the mode, independently of unfinished reference prose. Read-only commands do not alter the current selection or execute the generated instructions. See [spec authoring](../AGENTS.md) and [spec definitions](specs/README.md).

Both Git modes are required and independent:

- `git.user.mode = "managed"` supplies the default commit identity from this file and requires both `user.name` and `user.email`.
- `git.user.mode = "inherit"` uses Git's existing identity rules and requires both name/email fields to be absent. Keeping either field is a configuration error. Here `managed` refers to identity defaults supplied by GIDD, independently of whether the Git executable is GIDD-managed.
- `git.credential.mode = "gh"` supplies gh-backed credentials for the configured HTTPS host; `inherit` keeps Git's credential sources. Both modes disable common credential prompts.

Both modes must be configured explicitly. `set` and `clear` can repair one field at a time; complete the selected mode's requirements before invoking wrappers. No tokens are stored in this file.

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

`.git` / `.gh` 始终读取原入口仓库的配置，仅允许从入口仓库和 `workflow.workspace` 登记的关联 worktree（含普通子目录）调用。直接从其他仓库、内部子仓库或子模块、未登记 worktree、非仓库目录调用时，报错列出调用目录、识别出的仓库、入口仓库和配置路径，不回退、不提供 force。

workflow 命令统一显式接受 Issue 编号，从 Issue 的 gidd JSON 区块读取交付模式和分支约定。`workflow.workspace <Issue编号>` 准备工作区，`workflow.workspace --resume <Issue编号>` 核验原记录。每次操作都核对 Issue 与本地记录；不从调用目录猜测任务，也不回写 Issue 正文。结构见[Issue 与本地记录](references/data.md)。

push 按模式推送目标分支或开发分支。merge 按模式执行本地合并或查找对应 PR 合并；PR 可选 `--squash`、`--rebase`，合并标题可用 `--message` 指定。本地冲突保留现场；PR 的检查、保护规则或排队未完成时不报告交付成功。target-sync 在核验 PR 交付后快进同步本地目标分支。

cleanup 核验交付后清理开发分支并释放目录；PR 模式还清理远端同名开发分支。直接提交模式只删除本次上下文，保留目标分支和目录。中断重试仍使用 Issue 编号。`worktree.list`、`worktree.show <目录>`、`worktree.remove <目录>` 用于本机资源检查和移除；临时文件与进程由调用者处理。

这两组命令的 JSON 使用顶层 `issue`（`number`、`url`）关联任务，`delivery_mode` 表示交付方式，`target`（`repository`、`branch`、`remote.name/url`）表示交付目标，`worktree`（`path`、`state`、`development_branch`、`start_commit`）表示工作目录及本次任务记录。`schema`、`status`（`success` / `error`）、异常原因及操作结果留在顶层，无可用信息的对象省略。`worktree.state` 是 GIDD 管理状态，`unreleased` 不代表会话占用；`worktree.path` 也适用于 direct-commit 的目标仓库目录。起始提交点按本次任务记录，目录复用或下一次直接提交任务开始时刷新。`target.remote.name/url` 对应准备时记录的配置值，URL 已规范化；输出不含 `workflow` 对象；内部记录另行保存交付上下文。

`worktree.list` 省略目标仓库自身，条目沿用上述结构，摘要字段无值时省略。`--resume` 核验继续条件，`worktree.show` 用于查询排查；两者均显示实际 `worktree.head/checked_out_branch`，与登记的开发分支和起始提交点区分。Git 标志仅为 true 时显示，目录丢失时省略实际字段并报告原因。目标同步后的提交点为 `target.head`；show 按需保留清理依据和 `worktree.release_commit`。`worktree.remove` 明确拒绝删除目标仓库目录。登记与流程记录保存在 固定的 `<目标仓库>.gidd/state/`；检查及维护说明见[本地数据目录](references/data.md)。

仅校验调用目录；`-C`、`--git-dir`、`--work-tree`、`--repo` 等显式目标参数按原生语义处理，可以操作其他仓库，由调用者确认范围。仍沿用原入口的身份和凭据设置，不读取参数所指定仓库的 GIDD 配置。继承的 Git 目录及索引环境变量仍会清理。doctor、配置及 worktree 管理命令仍绑定入口仓库。

`.git` / `.gh` 禁用常见交互：编辑器直接报错、分页直接输出、禁止 Git 终端/AskPass 和 GCM 凭据询问；add、clean、commit、checkout、restore、reset、stash 的显式交互/补丁模式，以及 mergetool/difftool/gui/citool 直接失败。正常管道输入保留，请用参数或文件提供消息和必要数据。SSH 保留原命令及密钥/代理配置，追加 OpenSSH `BatchMode=yes` 或 PuTTY `-batch`；无法识别的自定义命令须声明 `ssh.variant` 或 `GIT_SSH_VARIANT`，不支持的变体报错。

hooks、alias、扩展、签名代理及任意外部程序可能自行等待或覆盖默认值，包装不是沙箱，也不会跳过签名或 hooks。可设置 `GIDD_EXEC_TIMEOUT_MS`（毫秒；未设置或 0 表示不限时），从实际转发命令启动时计时，超时终止 Windows 命令进程树并退出 124；取消退出 130。`.gh.auth` 保留独立设备授权及其超时。共享工具启动器不应用这些仓库包装策略。

Git for Windows 遇到文件占用时也不询问是否重试；先解决文件访问问题，再重新执行命令。

当前规范配置为 `[spec]` 下的 `current = "00/04.ask-commit"`。使用 `gidd.link spec.modes` 查看三种模式，`name` 为含编号的完整目录名，`specs` 表示可用规范数量，`spec.list <mode-id>` 查看规范和授权配置，`spec <mode-id>/<name>` 阅读完整提示，最后通过 `set spec.current <mode-id>/<name>` 选择。`clear spec.current` 移除选择。doctor（含离线模式）先检查模式目录命名及编号、模式名的唯一性，再检查当前规范及其依赖，至少一种语言完整才就绪，并报告完整解析结果和可用语言；重号时列出 details.conflicts，其他规范的未完成正文不影响当前规范。

`spec.list <mode-id>` 每项只返回规范名 `name` 和授权配置 `authorization`；未完成或无效的规范增加 `error`。可用数量按至少一种语言完整统计。`spec <mode-id>/<name>`、`spec.current` 组装模式说明、流程、授权及适用经验，所选语言必须完整，不混用语言；各 spec 命令均支持 `--lang en|zh`。`spec.issue <mode-id>/<name>`、`spec.issue.current` 读取模式声明的相对路径 JSON 模板，不受经验正文未翻译影响；不使用 Issue 的模式报告无模板。只读命令不会改变当前选择或执行生成的指引。定义格式见 [规范编写](../AGENTS.md) 与 [规范定义](specs/README.md)。

`gidd.link .gh.auth` 是独立授权入口：复用配置账号已核验的凭据；取不到该账号的 token 时发起设备授权，输出网址和设备码，完成后核验账号，凭据由 gh 保存。结果和授权事件分别使用 `gidd.auth/v1` 和 `gidd.auth.event/v1` JSON 格式。它不转发为 `.gh auth`；`.gh` 包装在执行原生参数前要求已有可验证的 token。

授权读取入口绑定目录的 `config.toml`，直接从 `repo.remote.url` 提取主机，使用 `repo.remote.account` 指定账号；仅要求 URL/account 字段有效及 gh 绑定版本符合要求。不要求 Git、`.git` 工作区、`repo.remote.name`、本地远端地址一致或 Git 身份/凭据配置完整；配置文件和工具绑定记录仍须能正常解析。doctor 继续诊断本地仓库及远端，授权成功不代表仓库访问权限或就绪状态。已有 token 核验失败时直接报告错误，不自动重新登录。

配置命令为 `gidd.link set.show`、`gidd.link set <字段> <值>`、`gidd.link clear <字段>`。不带参数的 `gidd.link set` 显示与 `gidd.link help` 相同的本地化主帮助，不读取或修改配置，配置缺失或损坏时也可查看；语言选择与 help 一致（优先 `GIDD_LANG`，再按系统语言）。`set.show` 向 stdout 原样输出 TOML，保留注释、BOM 和换行，不额外追加换行；不解析或校验配置，不完整或有语法错误时也能查看。文件不存在或读取失败时向 stderr 输出诊断并返回非零退出码；仍检查文件类型、路径、UTF-8 和大小。`set`、`clear` 结果仍使用 `gidd.config/v1` JSON 格式，doctor 的 `config.` 字段 ID 保持不变。

两入口提供默认环境，显式参数交给 Git/gh 处理。`git.user.mode` 必须填写 `managed` 或 `inherit`：前者要求姓名和邮箱两项必填，后者要求两项均省略；缺失模式或冲突配置均报错。独立的 `git.credential.mode` 必须填写 `gh` 或 `inherit`。`.gh` 从配置 URL 设置默认 host/repo，并使用指定账号已保存的 token；`.git` 在 managed 模式下用环境配置覆盖同名文件配置，保留 `-c`、`--author`、历史作者及签名的原生语义。

`set` 和 `clear` 允许逐字段修复；`.git` / `.gh` 包装要求配置完整。切换为 inherit 时，先执行 `clear git.user.name`、`clear git.user.email`，再执行 `set git.user.mode inherit`。clear 删除赋值，不写入空字符串；字段已不存在则成功且不重写配置，配置文件不存在也不会创建文件或目录。未知字段报错；必填字段允许清除，之后由 doctor/执行入口报告缺失。保留其余内容、BOM、换行和注释，行内注释转为独立注释，沿用 set 的文件锁和原子替换保护；结果以 `changed` 表示是否修改。

doctor 的 `config.git.user.mode` 报告模式和来源，`config.git.user.name`、`config.git.user.email` 分别检查对应字段：managed 下报告配置值，inherit 下省略为正常、填写为冲突。模式无效时，姓名和邮箱检查受阻并指向模式项；`folder.git.identity` 在 `details.author`、`details.committer` 中分别报告当前生效的作者、提交者姓名和邮箱，两项探测均成功才为 ready。这是当前执行环境的身份，不代表历史提交，也不保证后续提交必定成功；署名配置无效时指向首个失败字段，不将回退身份误报为就绪。

`gh` 模式仅为指定 HTTPS host 配置按需认证助手，不禁止 SSH。Git 本地操作不需要登录；缺少凭据时，在实际请求凭据的阶段失败。远端目标参数保留原生语义；两入口不修改全局身份或切换共享活动账号。`doctor` 用于诊断配置和实际生效身份，不能证明推送账号或权限。
