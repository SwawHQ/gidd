# GIDD 本地数据目录 / GIDD local data directory

此目录由 GIDD 技能管理：`state/` 保存本地登记及流程记录，`gidd-wt-<UUID>/` 是与目标仓库共享 Git 数据的专用 worktree。位置固定为 `<目标仓库>.gidd/`。
GIDD manages this directory: `state/` holds local resource and workflow records; `gidd-wt-<UUID>/` contains dedicated worktrees sharing Git data with the target repository. The location is fixed at `<repository>.gidd/`.

## 安全移除 / Safe removal

先确认任务已交付、工作区不再使用、相关进程已停止，并保存需保留的本地文件。在原仓库根目录运行下列命令；cleanup 沿用记录的交付模式，已释放的工作区可直接 remove。
Confirm delivery, stop using the worktree and its related processes, and preserve needed local files. Run these commands from the original repository root; cleanup uses the recorded delivery mode, or remove an already released worktree.

```powershell
.\.agents\skills\gidd\gidd.link.cmd worktree.list                             #查看 / List
.\.agents\skills\gidd\gidd.link.cmd workflow.cleanup <issue>               #核验交付并清理 / Verify delivery and clean up
.\.agents\skills\gidd\gidd.link.cmd worktree.remove <path>                    #移除目录 / Remove directory
```

cleanup 核验交付后删除本地开发分支并释放目录供复用；PR 模式自动查找并核验对应的已合并 PR，还会删除工作远端的同名开发分支。无法唯一确定交付 PR 时保留资源并报告原因。remove 删除已释放的目录。命令受阻时先处理原因，再重试，不要直接强删目录。
cleanup verifies delivery, deletes the local development branch and releases the directory for reuse; PR mode automatically finds and verifies the matching merged PR and also deletes the matching branch on the working remote. Inconclusive discovery retains resources and reports the reason. remove deletes a released directory. Resolve any reported blockers and retry instead of force-deleting directories.

所有专用 worktree 已移除、流程上下文已清理且其他需保留的文件已保存后，可删除此目录。仓库改名或搬移后，请运行 doctor 检查路径与 Git 关联，按报告人工处理。
After removing dedicated worktrees, cleaning up workflow contexts and preserving other needed files, this directory can be deleted. After repository renames or moves, run doctor to inspect paths and Git links, then resolve the reported issues manually.
