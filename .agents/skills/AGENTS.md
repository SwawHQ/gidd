# 规范编写

规范入口为 `gidd/specs/<编号.模式名>/<规范名>.toml`，只维护 `[authorization]`。模式编号取目录的两位数字前缀，初始为 `00`～`05`，不在代码或 TOML 中重复定义；编号和模式名各自唯一。所属模式的 `description.toml` 维护 `[authorization_schema]`、双语 `description` 一句话简介，以及 Issue 模式的 `[issue_template]` 相对路径。模式不另设标题或长正文，具体约定放在对应环节的参考经验中。六种模式决定固定流程，schema 只约束授权值，不能通过字段顺序定义流程。

共用的环节参考经验位于 `gidd/references/workflow/`。每个环节维护一份 TOML，使用 `[zh-CN."issue.*"]`、`[en."issue.*"]` 等表按模式选择 `title` 和 `body`；只有 `*` 是通配符，完整匹配去掉目录编号后的模式名。双语的模式集合须一致，不能有重叠匹配。正文参考已有经验，以几句话说明该环节的动作与约定，不套固定栏目，不决定授权。

中文未定稿前，英文模式简介、经验标题和正文保留为空。空白语言暂不能生成完整提示，不要为通过检查而补造翻译或混用语言。其他规范草稿不应阻断所选规范。

`gidd.link spec.modes` 列出模式，`spec.list <mode-id>` 列出规范和授权配置，`spec <mode-id>/<name> --lang zh|en` 生成完整提示。生成器负责流程、授权说明与适用经验的组装，不再使用 Markdown include 或命令占位符替换。Issue 模板命令始终绑定本次选择的规范和语言。

具体定义见 [specs/README.md](gidd/specs/README.md) 和 [workflow/README.md](gidd/references/workflow/README.md)。
