# 规范编写

每个规范维护 `prompt.en.md` 和 `prompt.zh-CN.md`，正文保持各自完整。修改时核对名称、摘要与正文的流程含义。

```yaml
---
description:
  - issue: required
  - branch_pr: optional
  - stage_commit_push: ask
  - merge_and_related_failures: auto
  - close_issue: auto
  - other_steps: auto
issue_template: ../_share/issue.zh-CN.json
---
```

`description` 的六项各出现一次，打印保留数组顺序；双语的键、值和顺序一致。`required` / `optional` 表示是否必需，`auto` / `ask` 表示自动处理或询问授权，`agent_decides` / `user_decides` 表示由 Agent / 用户决定是否执行及执行时机。具体授权条件保留在正文。

可选的 `issue_template` 相对于入口文件；英文入口引用英文模板，不提供模板时双语均省略。

## 包含正文

```text
@include ../_share/common.zh-CN.md@
```

在代码块外独占一行；路径相对于写下指令的文件，引用限于 `specs/` 内。片段只写正文，不带 front matter；嵌套引用也按各自文件解析，不能循环。内置规范无需引用 common。

## 模板命令替换

```text
@gidd.link spec.issue.current@
```

include 展开后，替换为 `gidd.link spec.issue <本次规范名> --lang en|zh`，名称和语言绑定本次打印的规范。行内代码和代码块中也会替换；只生成命令文字，不执行命令。front matter 和 JSON 模板不参与替换。
