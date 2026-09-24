# 规范配置

每个模式目录包含一份 `description.toml` 和若干子规范，例如 `00.auto.toml`。目录格式为 `<两位编号>.<模式名>`，例如 `00.issue.current-worktree.direct-commit`；完整规范标识为 `<模式目录>/<规范名>`，不含扩展名。

随技能提供的六种模式目录使用 `00`～`05` 前缀，`spec.modes` 的 `name` 显示含编号的完整目录名，不另列 `id`。编号直接读取目录前缀，不按目录排序或可用状态重新编号；代码和 TOML 不再另存编号。编号和去掉前缀后的模式名都必须唯一，冲突会报告对应目录。命令优先使用编号，例如 `spec.list 00`、`spec 00/00`、`set spec.current 00/00`；完整目录名、不带编号的模式名和完整规范名仍可使用。参考经验匹配去掉编号后的模式名，例如 `issue.*`。

规范编号取文件名的两位数字前缀，例如 `00/00` 匹配该模式下的 `00.auto.toml`；不按列表位置或可用状态选择。无匹配或存在多份同号规范时报告错误，同号时可使用完整规范名明确选择。读取、设置当前规范和 Issue 模板命令共用这一规则。

`description.toml` 定义 `[authorization_schema]`、模式的双语 `description` 一句话简介，以及有 Issue 模式共用的 `[issue_template]`。模式不另设 `title/body`，具体约定放在对应环节的参考经验中；经验模块仍使用 `title/body`。模板路径相对于声明它的 `description.toml`，使用明确的相对路径；无 Issue 模式不声明模板。

```toml
[zh-CN]
description = "以 Issue 为依据，在当前工作区的当前分支直接开发、提交并推送。"

[en]
description = ""
```

子规范只保存顶层 `[authorization]`，完整列出 `development`、`internal_acceptance`、`add`、`commit`、`push`、`push_error`、`merge`、`merge_error`、`close_issue`、`cleanup_sync`。不重复模式说明或模板，不使用默认值继承。

`[authorization_schema]` 用数组声明每项允许的取值：适用环节为 `["auto", "ask"]`，不适用环节为 `["not_applicable"]`。子规范必须包含 schema 中的全部项目，不得增加未知项目，每项取值必须属于对应数组。

- `auto`：在前置条件满足及授权范围内自动执行。
- `ask`：已有范围内的明确授权可继续，否则准备可检查的结果后询问。
- `not_applicable`：模式不包含此环节；不能用它跳过模式需要的环节。

`task_definition`、`workspace` 以及适用模式中的 `pr` 由模式固定安排并自动开展，不单列授权项。`development = "ask"` 可作为正式开发前的检查点。模式不允许在执行中临时选择是否使用 Issue、专用 worktree 或 PR。

推送受阻时进入 `push_error`，合并受阻时进入 `merge_error`；它们随对应主环节适用，并分别遵守授权。验收不通过时返回开发与验收；错误修复涉及修改、提交或推送时，重新经过相关环节及其授权。

本地合并模式先 merge 后 push，PR 模式先 push、创建或更新 PR，再 merge。程序按六种固定模式统一确定流程，不再配置 `workflow` 数组；schema 只约束授权配置，不能按经验模块编号或字段排列推断执行顺序。适用环节的文件名与配置键以连字符和下划线对应，例如 `internal_acceptance` 对应 `04.internal-acceptance.toml`。

共用的环节参考经验位于 [references/workflow](../references/workflow/README.md)，按模式和语言选择正文；`00.common.toml` 作为各模式的公共约定。模式说明和经验模块的英文暂留空，待中文定稿后统一翻译。

使用 `gidd.link spec.modes` 查看模式及可用规范数量（`specs`），再用 `spec.list <mode-id>` 查看规范和授权配置。`spec <mode-id>/<name>` 生成完整提示，`set spec.current <mode-id>/<name>` 保存选择，`spec.current` 生成当前规范提示；生成中文提示可加 `--lang zh`。

程序先检查模式目录命名与编号、模式名的唯一性，再加载所选规范及其依赖，不再展开 Markdown include。列表会标记未完成或无效的规范；至少一种语言的模式说明和适用经验完整才计入可用数量。生成时要求所选语言完整，不混用语言。doctor 使用同一套目录查找及冲突校验，报告当前配置的完整解析结果与可用语言；其他模式的未完成正文不会阻断当前规范。
