# Issue 与本地记录 / Issue and local records

Issue 正文包含一个 `gidd` JSON 代码块，保存 `schema: "gidd.issue/v1"`、`delivery_mode`、`target_branch`、`development_branch`。交付模式为 `direct-commit`、`direct-merge` 或 `pr-merge`；直接提交的开发分支为 null。通过 `spec.issue` 获取所选模式的模板，填写实际分支名称。

The Issue body contains one `gidd` JSON block with `schema: "gidd.issue/v1"`, `delivery_mode`, `target_branch` and `development_branch`. Modes are `direct-commit`, `direct-merge` and `pr-merge`; direct commit has a null development branch. Use `spec.issue` for the selected mode's template and fill in actual branch names.

workflow 命令显式接受 Issue 编号，每次读取 Issue 并核对本地记录；不会改写 Issue 正文。工作区路径、起始提交点、交付上下文快照及清理进度保存在本机。同一 Issue 在本机最多关联一个工作区，继续任务不会接管会话。PR 按仓库、分支和开发提交查找，无需预先保存编号。

Workflow commands require an Issue number, read the Issue and compare it with local records without editing its body. Paths, starting commits, delivery snapshots and cleanup progress stay local. Each Issue has at most one local workspace; resume does not claim a session. PRs are discovered by repository, branches and development commit, without a pre-recorded number.

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
