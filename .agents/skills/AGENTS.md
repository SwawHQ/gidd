# 工作流程配置

工作流程由交付模式和授权方案组成。授权方案位于 `gidd/flows/<编号.交付模式名>/<授权方案名>.toml`，只维护 `[authorization]`。交付模式编号取目录的两位数字前缀，初始为 `00`～`02`，不在代码或 TOML 中重复定义；编号和模式名各自唯一。所属交付模式的 `description.toml` 维护 `[authorization_schema]`、双语 `description` 一句话简介，以及 `[issue_template]` 相对路径。交付模式不另设标题或长正文，具体约定放在对应环节的参考经验中。三种交付模式决定固定流程，schema 只约束授权值，不能通过字段顺序定义流程。

共用的环节参考经验位于 `gidd/references/steps/`。每个环节维护一份 TOML，使用 `[zh-CN."*"]`、`[en."*"]` 等表按模式选择 `title` 和 `body`；只有 `*` 是通配符，完整匹配去掉目录编号后的模式名。双语的模式集合须一致，不能有重叠匹配。正文参考已有经验，以几句话说明该环节的动作与约定，不套固定栏目，不决定授权。

环节经验只说明 GIDD 工具和资源的特有用法；不重复通用 Git/GitHub 操作。无需补充说明的环节可以不设文件，或将正文留空，生成器仍会列出该环节及其授权。中文未定稿前，英文模式简介、经验标题和正文保留为空。模式简介为空的语言暂不能生成提示，不要为通过检查而补造翻译或混用语言。其他授权方案草稿不应阻断所选工作流程。

`gidd flow.deliveries` 列出交付模式，`flow.list <mode-id>` 列出授权方案，`flow <mode-id>/<name> --lang zh|en` 生成完整提示。生成器负责流程、授权说明与适用经验的组装，不再使用 Markdown include 或命令占位符替换。Issue 模板命令始终绑定本次选择的工作流程和语言。

具体定义见 [flows/README.md](gidd/flows/README.md) 和 [steps/README.md](gidd/references/steps/README.md)。


含 merge 的交付模式使用专用工作分支，命名为 gidd-issue-<Issue编号>。push 时，本地源分支与远端目标分支必须同名
