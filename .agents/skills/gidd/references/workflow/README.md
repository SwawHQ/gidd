# 环节参考经验

本目录的 TOML 保存参考经验，`specs/` 中的规范配置决定流程和授权。同一环节的不同场景集中在一个文件；`01.task-definition.toml` 负责澄清目标并确认 Issue。

文件编号为 `00`～`17`，用于按环节位置浏览。本地合并、PR 合并、本地目标分支同步和清理分别维护参考经验与授权；同步及其受阻处理仅适用于 PR 模式。具体模式只加载适用环节，错误处理紧随对应主环节展示。

```text
00.common
01.task-definition
02.workspace
03.development
04.internal-acceptance
05.add
06.commit
07.direct-merge
08.direct-merge-error
09.push
10.push-error
11.pr-create
12.pr-merge
13.pr-merge-error
14.target-sync
15.target-sync-error
16.close-issue
17.cleanup
```

```toml
[zh-CN."*"]
title = "commit"
body = '''
提交参考经验。
'''

[en."*"]
title = ""
body = ""
```

表名由语言和完整的模式表达式组成。表达式匹配去掉目录编号后的整个模式名，例如 `00.direct-commit` 使用 `direct-commit` 匹配；`*` 匹配任意字符（包括点号），只支持这一种通配符，普通字符按原样匹配。

同一文件、同一语言下，一个模式至多匹配一段，不叠加或按优先级覆盖。适用环节需要匹配的经验；`not_applicable` 环节不加载。经验匹配不决定执行顺序，也不增加模式原本没有的环节。

中文仍在整理，英文的 `title`、`body` 暂留空，待中文定稿后统一翻译。加载器按模式匹配适用正文；匹配存在歧义、缺失或双语模式不一致时报告对应文件。某种语言的适用正文尚未完成时，该语言暂不可用于生成提示，不影响其他已有完整正文的语言。
