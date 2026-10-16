# GIDD 本地数据目录 / Local data

GIDD 的本地数据目录固定为 `<目标仓库>.gidd/`。例如，目标仓库为 `D:/repos/demo/` 时，数据目录为 `D:/repos/demo.gidd/`。目标仓库和它的关联工作树共用这个数据目录。

GIDD stores local data at `<repository>.gidd/`. For example, a target repository at `D:/repos/demo/` uses `D:/repos/demo.gidd/` for its data. The target repository and its linked worktrees share this directory.

数据目录按以下结构保存：

```text
<目标仓库>.gidd/
├─ gh/                    #仓库专用的 gh 配置
├─ create-pending.json    #当前 Issue 创建请求及恢复记录
├─ policy-history.jsonl   #任务授权方案使用历史
├─ storage.json           #目录归属和可复用工作树的资源记录
├─ <Issue编号>/
│  ├─ state.json          #任务约定及工作区关联
│  └─ issue.md            #Issue 标题和正文的本地副本
├─ README.md
└─ gidd-wt-<UUID>/        #专用工作树
```

`issue --file <文件> --policy <授权方案>` 创建 Issue、登记任务并准备工作区；`<Issue编号> --policy <授权方案>` 登记已有 Issue 并准备或继续准备工作区。登记时创建 `<Issue编号>/state.json`，准备时补充工作区记录。所有交付模式都使用这份记录。后续命令按 Issue 编号读取已保存的授权方案与确认点、账号、交付模式、分支、起始提交点和仓库约定，不从 Issue 正文或当前授权方案重新确定这些信息。

`issue --file <file> --policy <policy>` creates an Issue, registers its task and prepares its workspace. `<Issue编号> --policy <policy>` registers an existing Issue and prepares or resumes its workspace. Registration creates `<Issue编号>/state.json`; preparation adds the workspace record. All delivery modes use this record. Later commands use the Issue number to read the saved authorization policy and approval points, account, delivery mode, branches, starting commit and repository bindings, rather than deriving them from Issue prose or the current authorization policy.

`state.json` 的 `policy` 保存授权方案标识 `selector`、交付模式 `mode` 和授权配置 `authorization`。`delivery` 保存交付模式 `mode` 和远程绑定 `remote`。远程绑定包含获取来源仓库、获取分支和推送目标仓库。独立工作树的对应记录保存在 `storage.json` 的 `worktrees` 中，也使用 `delivery` 字段。`gidd <Issue编号>` 将这些信息打印为 `delivery_mode` 和 `target.remote`。任务命令输出使用 `gidd.task-command/v1`；任务文件使用 `gidd.task/v1`。

The `policy` field in `state.json` stores the authorization policy selector (`selector`), delivery mode (`mode`) and authorization settings (`authorization`). The `delivery` field stores the delivery mode (`mode`) and remote binding (`remote`). The binding contains the fetch repository, fetch branch and push repository. Dedicated worktree records are stored under `worktrees` in `storage.json` and also use `delivery`. `gidd <Issue编号>` reports these values as `delivery_mode` and `target.remote`. Task command output uses `gidd.task-command/v1`; task files use `gidd.task/v1`.

`state.json` 的 `registration` 保存登记 ID 和完成状态，供中断后补写 Issue 副本及授权方案历史。`preparation` 在执行 fetch 或快进更新目标分支前，保存已确定的起始提交点、更新前的提交点，以及获取来源使用的临时 Git 引用。重试沿用已保存的提交点，先核对记录与 Git，再继续准备。

The `registration` field in `state.json` saves the registration ID and completion state so interrupted writes of the Issue copy and authorization policy history can resume. Before fetch or a target branch fast-forward, `preparation` saves the selected starting commit, the previous commit and any temporary Git reference used to fetch the source. A retry retains the saved commit and checks the records against Git before continuing.

本地合并成功后，工作树资源记录的 `local_merge` 只保存参与合并的工作提交 `head` 和目标分支的结果提交 `commit`。后续交付检查确认工作提交未变，且结果提交仍在目标分支历史中；普通 merge 也可直接用提交历史核验。复用工作树时移除这份记录。

After a local merge succeeds, the worktree resource record's `local_merge` field stores only the source commit (`head`) and the result commit on the target branch (`commit`). Delivery checks confirm that the source has not changed and that the target history contains the result. A normal merge can also be verified from commit history. Worktree reuse removes this record.

squash 修改目标工作区前，先保存 `head`、合并前目标提交 `before`、预期结果 `tree` 和提交标题 `message`。中断后按这些信息核对 Git；确认结果后，将临时记录替换为两个提交 hash。

Before squash changes the target checkout, it stores `head`, the previous target commit (`before`), the expected result tree (`tree`) and the commit title (`message`). A retry checks Git against this plan. Once confirmed, the two commit hashes replace the plan.

专用工作树在操作 Git 前，将准备意图保存到 `storage.json` 中对应 UUID 的 `preparation` 字段，同时保存 Issue 编号、工作分支、目标分支和起始提交点。复用工作树时也保存原释放记录。重复执行编号命令时，按 Issue 编号找到同一工作区，核对 Git 现场并补做未完成操作。记录与实际状态不一致时停止，不扫描系统临时目录，也不自动恢复其他任务。

Before Git changes, dedicated worktree preparation saves its intent in the corresponding UUID record's `preparation` field in `storage.json`, with the Issue number, working branch, target branch and starting commit. Reuse also saves the previous release record. A repeated numbered command finds the same workspace by Issue number, checks its actual Git state and completes unfinished operations. Inconsistent state stops preparation. Commands do not scan system temporary directories or resume other tasks automatically.

创建 Issue 前，`create-pending.json` 保存请求 ID、草稿绝对路径及内容校验值、授权方案和任务约定。阶段依次为 `planned`、`creating`、`created`、`ready`。收到 Issue 编号后，先保存编号，再登记任务；完成后保留最近一次请求。草稿路径、内容和 `--policy` 参数相同的请求重试时，沿用已确认的编号，不再次创建 Issue。未完成的创建请求会阻止其他创建请求覆盖它。

Before creating an Issue, `create-pending.json` saves the request ID, absolute draft path and content hash, authorization policy and task plan. Its phases are `planned`, `creating`, `created` and `ready`. After receiving an Issue number, the command saves that number before task registration; completion retains the latest request. A request with the same draft path, contents and `--policy` argument uses the confirmed number without creating another Issue. An unfinished creation request prevents another request from replacing its record.

已有编号时，优先用 `gidd <Issue编号> --policy <授权方案>` 继续。准备成功后，匹配的已确认创建记录标记为 `ready`，可以开始下一次创建。创建结果不明时先核对交付仓库；记录不能证明远端没有创建 Issue，命令不会自动重复提交创建请求。只有确认远端结果后，才可人工移除这份创建记录。

With a known number, use `gidd <Issue编号> --policy <policy>` to continue. Successful preparation marks the matching confirmed creation record `ready`, so a new creation request can start. An unknown creation result requires checking the delivery repository first. The record cannot prove that no remote Issue was created; the command does not automatically repeat the creation request. Remove this creation record manually only after confirming the remote result.

`policy-history.jsonl` 每行保存时间 `at` 和完整授权方案标识 `selector`。首次登记的条目也可保存登记 UUID `id`，中断后按此 ID 去重；`.policy.set` 的条目只保存时间和授权方案标识。平时追加；超过500条时，只保留最新200条。未写完的末行不算记录，下次写入时移除。`policy.history` 倒序显示最近200条，`-v` 加上时间。首次绑定及成功修改任务授权方案时追加记录；查看或重复准备工作区不追加。`<Issue编号>.policy` 使用任务保存的确认点。历史在任务清理后仍保留，不表示用户已授权新的操作。

Each line in `policy-history.jsonl` stores the time (`at`) and full authorization policy name (`selector`). Initial registration entries can also store their registration UUID (`id`) to prevent duplicate entries after an interrupted append; `.policy.set` entries store only the time and authorization policy name. New records are appended. Above 500 records, only the latest 200 are retained. An unfinished final line is ignored and removed on the next write. `policy.history` shows the latest 200 records, newest first; `-v` adds timestamps. Initial binding and successful changes append records; viewing or repeated preparation does not. `<Issue编号>.policy` uses the saved task approval points. History remains after task cleanup and does not grant approval for new actions.

任务账号记录只包含登录名。`gh/` 保存仓库的 gh 配置，由 `gh.auth` 创建，任务清理时保留。凭据由 gh 管理，不写入任务记录。

Task account records contain only login names. `gh.auth` creates `gh/` for repository-specific gh configuration; task cleanup retains it. gh manages credentials, which are not written to task records.

创建或登记 Issue 时，命令将标题和正文副本保存为 `<Issue编号>/issue.md`。重复准备会保留已有副本；本地副本与 GitHub Issue 不会自动同步。通过 `--file` 提供的草稿由调用者管理，创建命令不会修改或删除它。

Creating or registering an Issue saves its title and body to `<Issue编号>/issue.md`. Repeated preparation retains the existing copy. The local copy and GitHub Issue do not synchronize automatically. The caller manages the draft supplied with `--file`; the creation command does not modify or delete it.

尚未保存准备意图且未分配工作区时，`<Issue编号>.cleanup` 撤销未准备的任务登记，删除 Issue 编号目录。若匹配的创建记录已确认该 Issue，则将它标记为 `ready`，可以开始下一次创建。GitHub 上的 Issue 保留。

Before a preparation intent or workspace allocation exists, `<Issue编号>.cleanup` removes the unprepared task registration and its numbered directory. If the matching creation record confirms that Issue, cleanup marks it `ready` so a new creation request can start. The GitHub Issue remains.

已保存准备意图后中断时，`<Issue编号>.cleanup` 可以撤销未完成的工作区准备，保留任务和 Issue 副本。新建工作树仅在没有用户文件或修改时移除；复用工作树恢复原释放状态。资源不安全时停止。修复后，仍可执行编号命令继续准备。

After an interruption with a saved preparation intent, `<Issue编号>.cleanup` can undo unfinished workspace preparation and retain the task and Issue copy. It removes a new worktree only when no user files or changes are present, or restores a reused worktree to its previous released state. Unsafe resources stop cleanup. After repairs, the numbered command can prepare the workspace again.

交付完成后，`<Issue编号>.cleanup` 成功时删除整个 Issue 编号目录，包括文本副本和其中的临时文件。专用工作树及其释放记录保留，供后续检查、移除或复用。cleanup 不删除远端 Issue；编号目录之外的草稿由调用者清理。

After delivery, successful `<Issue编号>.cleanup` deletes the entire Issue directory, including its text copy and temporary files. Dedicated worktrees and their release records remain available for inspection, removal or reuse. Cleanup retains the remote Issue; the caller removes drafts outside the numbered directory.

登录账号或登记任务时，GIDD 按需创建数据目录和说明文件。已有配置和记录会保留。

GIDD creates the data directory and its notice when authorizing an account or registering a task. It retains existing configuration and records.

仓库改名、搬移或数据损坏时，根据诊断报告人工检查目录和 Git 关联。修复后，重新运行 `gidd doctor`。需要移除本地数据时，先阅读数据目录内的 `README.md`，按其中的安全移除步骤处理。

After a repository rename, move or data damage, inspect the directories and Git links identified in the diagnostic report. After repairs, run `gidd doctor` again. Before removing local data, read the `README.md` in the data directory and follow its removal procedure.
