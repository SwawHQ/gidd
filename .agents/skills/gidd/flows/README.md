# 工作流程配置

工作流程由交付模式和授权方案组成。每个交付模式目录包含一份 `description.toml` 和若干授权方案，例如 `00.auto.toml`。

目录格式为 `<两位编号>.<交付模式名>`，例如 `00.direct-commit`。完整工作流程标识为 `<交付模式目录>/<授权方案名>`，不含扩展名。`00/05` 选择 `00.direct-commit/05.ask-push.toml`。

三种交付模式都以 Issue 为任务依据。直接提交在目标仓库开发、提交并推送；直接合并在专用工作树开发，本地合并后推送目标分支；PR 合并在专用工作树开发，通过 PR 交付。

## 选择与配置

`gidd flow.deliveries` 列出交付模式；`gidd flow.list 00` 列出该交付模式的授权方案；`gidd flow 00/05` 显示组合后的工作流程。`<Issue编号> --flow 00/05` 登记任务并准备工作区，`<Issue编号>.flow.set 00/05` 修改任务的工作流程。

交付模式列表使用 `deliveries` 字段，其中 `presets` 是可用授权方案的数量。授权方案列表使用 `delivery_mode` 标明所选交付模式，用 `presets` 保存各方案；Issue 模板输出也使用 `delivery_mode`。任务快照中的 `flow.mode` 仍表示该工作流程的交付模式。

编号取目录名或文件名开头的两位数字。也可使用完整交付模式名和授权方案名。各交付模式的编号及去掉编号后的名称须唯一。同一交付模式内的授权方案编号重复时，使用完整授权方案名区分，例如 `00/00.auto`。以下划线开头的授权方案文件是草稿，不进入可选列表。

交付模式的 `description.toml` 包含：

- `[authorization_schema]`：各步骤允许的授权值。
- 双语 `description`：交付模式简介。
- `[issue_template]`：各语言的 Issue 模板，路径相对于这份配置文件。

授权方案只保存 `[authorization]`，为 `[authorization_schema]` 声明的每个项目选择一个值。模式简介和 Issue 模板由交付模式提供。示例见 [交付模式定义](00.direct-commit/description.toml) 和 [授权方案](00.direct-commit/00.auto.toml)。

## 步骤授权

`[authorization_schema]` 使用数组声明允许值，`[authorization]` 使用单个值选择授权要求：

- `auto`：在前置条件满足及授权范围内自动执行。
- `ask`：已有明确授权覆盖该步骤时可继续；否则先准备可检查的结果，再请求授权。
- `not_applicable`：交付模式不包含此步骤，不能用它跳过适用步骤。

步骤授权用于生成 Agent 执行提示。GIDD 命令本身不会弹出步骤授权确认。

任务界定 `task_definition`、工作区准备 `workspace`，以及 PR 模式的创建或更新 PR `pr_create`，在提示中固定为 `auto`，不进入可配置授权表。`development = "ask"` 表示正式开发前需要确认授权。

错误处理仅在对应步骤受阻时适用，并单独配置授权，例如 `push` 和 `push_error`。修复涉及开发、提交或推送时，仍使用相关步骤的授权要求。

## 步骤与说明

步骤顺序由 `scripts.js/shared/flow-definition.mjs` 中的 `deliveryModePlan()` 固定。该模块也定义工作流程选择器和快照。授权表只选择授权要求，字段排列不改变步骤顺序。提交后的交付顺序如下：

| 交付模式 | 提交后的步骤 |
| --- | --- |
| `direct-commit` | push → close_issue → cleanup |
| `direct-merge` | direct_merge → push → close_issue → cleanup |
| `pr-merge` | push → pr_create → pr_merge → target_sync → close_issue → cleanup |

[步骤说明](../references/steps/README.md) 提供可选的工具参考，不定义步骤或授权。没有说明文件的步骤仍保留在流程中。流程步骤也不等于 GIDD 命令；例如 `pr_create` 可通过 `gidd gh` 或原生 gh 完成。

任务登记时保存工作流程标识、交付模式和步骤授权。后续修改授权方案文件不会改变任务保存的授权要求；工具说明使用当前版本的参考文件。工作区已准备后，`.flow.set` 只能选择同一交付模式内的授权方案。选用历史保存在本地数据目录中，不构成本次授权。

## 检查配置

模式简介和步骤说明的英文暂留空。生成某种语言的提示时，该语言的交付模式简介须完整；步骤正文可省略，提供正文时须有标题。其他交付模式未完成的内容不会阻止当前工作流程生成提示。

`gidd flow.list 00` 检查授权方案列表，`gidd flow 00/05 --lang zh` 检查实际生成的提示。
