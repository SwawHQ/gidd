# Issue 与本地记录 / Issue and local records

Issue 记录需求、验收及交付关联，不承载机器配置。首次 `workflow.workspace <Issue编号>` 在线核验 Issue；交付模式取入口的 `spec.current`，目标分支取目标仓库当前分支。合并模式创建 `codex/issue-<编号>` 开发分支；直接提交的开发分支为 null。

Issues contain requirements, acceptance and delivery links, without machine configuration. Initial `workflow.workspace <issue>` checks the Issue online, takes the delivery mode from the entry's `spec.current` and the target branch from the target checkout. Merge modes create `codex/issue-<number>`; direct commit has no development branch.

workflow 命令按 Issue 编号定位本地记录，后续沿用已保存的模式、分支、起始提交点及远端，不重新读取 Issue 或当前规范。resume 只核对本地记录与 Git 状态，不需要 GitHub 凭据或网络，也不接管会话。同一 Issue 在本机最多关联一个工作区。推送及交付核验按需访问远端；PR 按仓库、来源/目标分支和开发提交匹配，目标不同则报告，保留现场。

Workflow commands locate local records by Issue number and retain the saved mode, branches, starting commit and remote without rereading the Issue or current spec. Resume checks local records and Git state without GitHub credentials or network access, and does not claim a session. Each Issue has at most one local workspace. Push and delivery verification access remotes as needed; PR discovery checks repository, head/base branches and development commit, retaining resources when the target differs.

# GIDD 本地数据目录 / Local data

数据目录固定为 `<目标仓库>.gidd/`，关联 worktree 共用主工作树旁的目录。`state/storage.json` 保存目录归属，`state/worktrees/` 保存专用 worktree 登记，`state/workflows/` 保存直接提交的流程上下文。专用 worktree 使用 `gidd-wt-<UUID>/` 命名，并通过绝对路径关联 Git。

Local data lives at `<repository>.gidd/` beside the main checkout, shared by linked worktrees. `state/storage.json` identifies the owner; `state/worktrees/` holds dedicated worktree records; `state/workflows/` holds direct-commit contexts. Dedicated worktrees use `gidd-wt-<UUID>/` names and absolute Git links.

`gidd.pre.ensure --repo` 准备工具及入口后调用 `gidd.link init`，创建缺失的基础配置、数据目录、说明文件和忽略规则；已有有效配置及记录保持原样。初始化先核对 GIDD worktree 的路径和登记，异常时报告并停止。`--check` 与 `--tools-only` 不初始化仓库。

After preparing tools and the entry, `gidd.pre.ensure --repo` calls `gidd.link init` to create missing basic configuration, local data, the notice and ignore rules. Valid configuration and records are retained. Initialization checks GIDD worktree paths and registrations first, reporting inconsistencies without proceeding. `--check` and `--tools-only` do not initialize repository data.

Doctor 的 `folder.gidd` 检查核对目录归属、Git 登记的 `gidd-wt-` 路径与实际目录、以及 GIDD 记录是否一致。配置或某条记录损坏时仍检查其余可读内容；普通用户 worktree 不属于此检查。

Doctor's `folder.gidd` check verifies directory ownership and consistency between registered `gidd-wt-` paths, actual directories and GIDD records. Damaged configuration or individual records do not prevent checking other readable resources. Ordinary user worktrees are outside this check.

仓库改名、搬移或数据损坏时，请按报告人工检查目录和 Git 关联，处理后重试初始化或 doctor。安全移除方式见目录内的 `README.md`。

After repository renames, moves or data damage, inspect the reported directories and Git links manually, then retry initialization or doctor. See the directory's `README.md` for removal guidance.

命令协调锁位于入口配置旁，仅保护命令执行，不表示任务或 Agent 会话占用。配置、生成的入口和锁由技能目录内的 `.gitignore` 忽略；已被 Git 跟踪的文件不会自动取消跟踪。

The lock beside the entry configuration protects command execution, not task or agent-session ownership. The skill's local `.gitignore` excludes configuration, generated entry and locks; already tracked files are not automatically untracked.
