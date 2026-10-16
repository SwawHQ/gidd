# GIDD 本地数据目录 / GIDD local data directory

此目录由 GIDD 技能管理：`storage.json` 保存目录归属和工作树资源记录，`<Issue编号>/` 保存任务记录和 Issue 文本副本，`gidd-wt-<UUID>/` 是与目标仓库共享 Git 数据的专用 worktree。位置固定为 `<目标仓库>.gidd/`。
GIDD manages this directory: `storage.json` holds ownership and worktree resource records; `<Issue编号>/` holds task records and Issue copies; `gidd-wt-<UUID>/` contains dedicated worktrees sharing Git data with the target repository. The location is fixed at `<repository>.gidd/`.

`policy-history.jsonl` 保存授权方案名和时间，清理任务时保留；超过500条时保留最新200条，供后续选择参考。
`policy-history.jsonl` retains authorization policy names and timestamps after task cleanup. Above 500 records, it keeps the latest 200 for later reference.

`gh/` 保存仓库专用的 gh 配置，供任务命令和 `gidd gh` 使用，清理任务时保留。凭据由 gh 管理；删除此目录不会清除系统凭据存储中的令牌。
`gh/` holds the repository-specific gh configuration used by task commands and `gidd gh`, and survives task cleanup. gh manages credentials; deleting this directory does not remove tokens from the system credential store.

## 安全移除 / Safe removal

先确认任务已交付、工作区不再使用、相关进程已停止，并保存需保留的本地文件。在原仓库根目录运行下列命令；cleanup 沿用记录的交付模式，已释放的工作区可直接 remove。
Confirm delivery, stop using the worktree and its related processes, and preserve needed local files. Run these commands from the original repository root; cleanup uses the recorded delivery mode, or remove an already released worktree.

```powershell
.\.agents\skills\gidd\gidd.cmd worktree.list           #查看 / List
.\.agents\skills\gidd\gidd.cmd <Issue编号>.cleanup     #核验交付并清理 / Verify delivery and clean up
.\.agents\skills\gidd\gidd.cmd worktree.remove <path>  #移除目录 / Remove directory
```

准备中断时，cleanup 只撤销确认安全的未完成准备，保留任务记录和 Issue 副本。新建工作树没有用户文件或修改时才移除；复用工作树恢复原释放状态。修复后，用 `gidd <Issue编号> --policy <授权方案>` 继续准备。
For interrupted preparation, cleanup undoes only verified unfinished preparation and retains the task and Issue copy. It removes a new worktree only when no user files or changes are present, or restores a reused worktree to its previous released state. After repairs, use `gidd <Issue编号> --policy <policy>` to prepare again.

交付完成后，cleanup 成功时删除对应的 Issue 编号目录及其中的文件。核验交付后删除本地工作分支并释放目录供复用；PR 模式自动查找并核验对应的已合并 PR，还会删除交付仓库的同名工作分支。无法唯一确定交付 PR 时保留资源并报告原因。remove 删除已释放的目录。命令受阻时先处理原因，再重试，不要直接强删目录。
After delivery, successful cleanup deletes the corresponding Issue directory and its files. It verifies delivery, deletes the local working branch and releases the directory for reuse; PR mode automatically finds and verifies the matching merged PR and also deletes the matching branch on the working remote. Inconclusive discovery retains resources and reports the reason. remove deletes a released directory. Resolve any reported blockers and retry instead of force-deleting directories.

所有专用 worktree 已移除、任务记录已清理且其他需保留的文件已保存后，可删除此目录。仓库改名或搬移后，请运行 doctor 检查路径与 Git 关联，按报告人工处理。
After removing dedicated worktrees, cleaning up task records and preserving other needed files, this directory can be deleted. After repository renames or moves, run doctor to inspect paths and Git links, then resolve the reported issues manually.
