# Spec resources / 规范资源

## Commands / 命令

```text
gidd.link spec.list
gidd.link spec 04.issue.ask-commit
gidd.link spec.current
gidd.link spec.issue 04.issue.ask-commit
gidd.link spec.issue.current
```

All accept `--lang en|zh`. The two `.current` commands read `spec.current` from config.toml. Named commands interpret their argument literally, even a spec named `current`. Old dynamic routes are removed.

以上均支持 `--lang en|zh`。两个 `.current` 命令读取配置；指定名称的命令按字面查找，包括名为 `current` 的规范。旧动态路由已移除。

## Entry files / 入口文件

Each selectable spec has `specs/<name>/prompt.en.md` and `prompt.zh-CN.md`. Names use lowercase segments separated by dots, optionally preceded by a two-digit prefix such as `00.all.auto`. Presets use `00`–`13` and sort by their full names. The prefix is part of the name in commands and config.toml: there are no numeric or unnumbered aliases. Keep assigned numbers stable; renumbering changes the selection name. Custom specs may omit the prefix. `_share/`, `_lib/` and other underscore-prefixed directories are helpers. Directories without either prompt are placeholders and are not listed. Once either exists, both languages must be complete.

每个可选规范都有双语入口。名称支持小写点分段及可选的两位数字前缀，如 `00.all.auto`。预设编号为 `00`–`13`，按完整名称排序；命令和 config.toml 均使用完整名称，不提供纯数字或去编号别名。编号应尽量固定，重新编号即改名；自定义规范可不带编号。下划线开头目录是辅助资源；没有任何 prompt 的目录属于占位，不列入列表。有任意一种语言的入口后，必须补齐两种语言。

```markdown
---
description: 提交并推送前需确认的 Issue 流程。
issue_template: ../_share/issue.zh-CN.json
---

# My workflow

@include ../_share/common.zh-CN.md@

## 流程

实现前建立或关联 Issue。完成实现和验证后，展示改动并征询提交、推送授权。
模板通过 @gidd.link spec.issue.current@ 打印。
```

`description` is required. `issue_template` is optional and resolves relative to this entry. A local template uses `./issue.zh-CN.json`; shared and local paths have identical semantics. No other file is chosen if the declared file is missing. Without this field, the workflow remains readable but requesting its Issue template reports `spec_issue_template_missing`. The two translations must agree on whether a template is declared; their JSON form structures must match. Additional front matter fields are rejected. Only the body appears in spec output.

`description` 必填。可选的 `issue_template` 相对于入口解析；本地模板写 `./issue.zh-CN.json`，共享模板写相应相对路径，两者没有优先级之分。声明文件缺失就报错，不回退。未声明时仍可读取正文，但请求模板会报告 `spec_issue_template_missing`。双语声明是否存在及模板字段结构必须一致。额外元数据字段不接受，打印时只输出正文。

## Shared Issue template / 共享 Issue 模板

The shared template has five sections: Goal, Scope, optional Non-goals, Acceptance checklist, and Delivery record. Each acceptance checkbox describes an outcome and how to verify it; shared methods may be stated once. Add actual results or evidence under the corresponding item, and check it off only after verification confirms it is met. Explain unchecked items as needed (not run, failed or blocked). Delivery record may start empty and later records delivery locations, target-branch status and pending authorization or undelivered work; it does not repeat verification results or replace the selected spec's authorization rules.

共享模板分为五段：目标、范围、非目标（选填）、验收清单、交付记录。每条验收勾选项写明完成结果和验证方法，共用方法可统一说明；实际结果或证据在对应条目下补充，验证确认满足标准后才勾选。未勾选项按需注明未执行、失败或受阻原因。交付记录创建时可留空，后续简记交付位置、目标分支状态及待授权或未交付事项，不重复验证结果，也不代替所选规范的授权要求。

For existing Issues, move the former Validation section's methods into Acceptance checklist and its actual results under the corresponding items. Retain delivery information in Delivery record (formerly 完成记录 in Chinese), and move explicitly excluded work from Scope into Non-goals when useful. Preserve existing evidence and completion status during restructuring. This template change does not automatically rewrite existing Issues.

已有 Issue 如需调整结构，将原“验证方式”中的方法并入“验收清单”，实际结果归入对应条目；原“完成记录”中的交付信息保留在“交付记录”，范围中明确排除的工作按需移入“非目标”。整理时保留已有证据和完成状态；模板变更不会自动改写已有 Issue。

## Includes / 包含正文

Use a standalone `@include relative/path.md@` line outside fenced or indented code. References resolve relative to the file containing the directive, including inside nested fragments. Fragments contain Markdown bodies without front matter. Repeated noncyclic inclusion is allowed. All resources must be plain files within `specs/`; absolute paths and links through symlinks or junctions are rejected.

在代码块外独占一行写 include。路径相对于写下指令的文件，嵌套片段也遵循此规则。共享片段只包含正文，不带 front matter。同一片段可重复引用，但不能循环。引用必须位于 specs/ 内，不能使用绝对路径、符号链接或 junction 绕到外部。

Files are limited to 64 KiB, includes to 16 nested levels and 256 file visits per language, and assembled text to 256 KiB. The command validates both languages and assembles the full result before printing; errors never emit a partial workflow. Ordinary prose and Markdown links are not include directives. Use the command placeholder below to reference the template of the spec being printed.

单文件最多 64 KiB，每种语言最多 16 层嵌套、256 次文件访问，展开正文最多 256 KiB。两种语言及依赖完整校验后才输出；失败不打印半份规范。普通正文和 Markdown 链接不作为包含指令处理。正文用下面的命令占位符引用本次打印的规范模板。

`spec.list` and configuration selection validate entry metadata. Reading a spec and doctor additionally validate the selected workflow's includes and declared templates. A malformed published entry is an error, not a reason to silently choose another spec.

列表和配置选择校验入口元数据；读取规范和 doctor 进一步校验所选规范的完整包含依赖及声明模板。已发布入口损坏必须修复，不会静默选择其它规范。

## Command placeholder / 命令占位符

Write `@gidd.link spec.issue.current@` wherever the prompt should show its template command. After includes are expanded, `spec <name>` and `spec.current` replace every exact occurrence in the body with `gidd.link spec.issue <resolved-name> --lang en|zh`, preserving the language of the printed prompt. For example, printing `04.issue.ask-commit` in Chinese produces `gidd.link spec.issue 04.issue.ask-commit --lang zh`, even if config.toml selects another spec.

在正文需要显示模板命令的位置写 `@gidd.link spec.issue.current@`。include 展开后，`spec <名称>` 和 `spec.current` 将正文中的每个完整占位符替换为 `gidd.link spec.issue <实际规范名> --lang en|zh`，语言与本次正文一致。例如打印中文 `04.issue.ask-commit` 时，得到 `gidd.link spec.issue 04.issue.ask-commit --lang zh`，不受配置中其它规范选择的影响。

This is literal text replacement, including inside inline code and code blocks; it does not run the command or fetch the template. Other `@...@` text remains unchanged. JSON template output and front matter are not rendered this way. A spec without `issue_template` still reports a missing template when its generated command is run.

这是文字替换，行内代码和代码块中的同一占位符也会替换；不会执行命令或读取模板结果。其它 `@...@` 文字保持原样，JSON 模板输出和 front matter 不参与替换。未声明 `issue_template` 的规范，执行生成的命令时仍会报告模板缺失。

## Presets / 预设

The names describe workflow requirements and authorization points. `issue` requires an Issue before development; `pr` additionally requires a dedicated development branch and delivery through a PR. Presets `02`–`05` allow development on the target branch without requiring a separate branch or PR; they also allow a branch or PR workflow. Presets `06`–`13` require it. For `02`–`13`, the target is the remote default branch unless the user explicitly specifies another one.

名称表示流程要求及授权节点：`issue` 要求开发前明确已有 Issue；`pr` 进一步要求专用开发分支并通过 PR 交付。`02`–`05` 允许在目标分支开发，不强制另建分支或 PR，但也允许采用分支或 PR 流程；`06`–`13` 则要求该流程。`02`–`13` 的目标分支默认为远端默认分支，用户明确指定时按其指定。

In the table, Agent means the Agent chooses whether and when a step applies; User means the user decides. Auto means continue when applicable and ready; Ask means obtain authorization unless it is already explicitly granted for the scope. Merge applies only when a branch or PR workflow is used. Neither `all` preset requires an Issue or PR; `01.all.ask` also leaves development, review, testing and cleanup decisions to the user. Existing explicit authorization remains valid, and silence is not approval.

表中 Agent 表示 Agent 自主决定是否执行及执行时机；User 表示由用户决定；Auto 表示适用且条件满足后自动继续；Ask 表示需获得授权，同一范围已有明确授权时沿用。合并仅在采用分支或 PR 流程时适用。两个 `all` 预设均不强制 Issue 或 PR；`01.all.ask` 的开发、review、测试及清理也由用户决定。已有明确授权继续有效，不以沉默代替批准。

| Spec / 规范 | Issue | Branch + PR / 分支及 PR | Commit / push | Merge / 合并 | Close / 关闭 |
| --- | --- | --- | --- | --- | --- |
| `00.all.auto` | Agent | Agent | Agent | Agent | Agent |
| `01.all.ask` | User | User | User | User | User |
| `02.issue` | Required / 必需 | Optional / 可选 | Auto | Auto | Auto |
| `03.issue.ask-close` | Required / 必需 | Optional / 可选 | Auto | Auto | Ask |
| `04.issue.ask-commit` | Required / 必需 | Optional / 可选 | Ask | Auto | Auto |
| `05.issue.ask-commit.ask-close` | Required / 必需 | Optional / 可选 | Ask | Auto | Ask |
| `06.issue.pr` | Required / 必需 | Required / 必需 | Auto | Auto | Auto |
| `07.issue.pr.ask-close` | Required / 必需 | Required / 必需 | Auto | Auto | Ask |
| `08.issue.pr.ask-commit` | Required / 必需 | Required / 必需 | Ask | Auto | Auto |
| `09.issue.pr.ask-commit.ask-close` | Required / 必需 | Required / 必需 | Ask | Auto | Ask |
| `10.issue.pr.ask-merge` | Required / 必需 | Required / 必需 | Auto | Ask | Auto |
| `11.issue.pr.ask-merge.ask-close` | Required / 必需 | Required / 必需 | Auto | Ask | Ask |
| `12.issue.pr.ask-commit.ask-merge` | Required / 必需 | Required / 必需 | Ask | Ask | Auto |
| `13.issue.pr.ask-commit.ask-merge.ask-close` | Required / 必需 | Required / 必需 | Ask | Ask | Ask |

For `02`–`13`, commit includes pushing by default. `ask-commit` also covers staging: do not run git add, commit or push before authorization. `00` and `01` describe commit and push separately. Follow explicit user instructions, including a request to commit without pushing.

`02`–`13` 的 commit 默认包含 push，`ask-commit` 也包含暂存：授权前不执行 git add、commit、push。`00`、`01` 分别描述 commit 和 push。用户明确要求只提交不推送时，按其要求执行。

`ask-merge` covers both merging and handling related problems such as failed Actions, unmet repository requirements or missing target-branch delivery. Prepare and report the result before requesting authorization. `ask-close` requires closure authorization even when committing, pushing or merging would close an Issue automatically; commit or merge authorization alone is insufficient. All Issue presets require completed scope, satisfied acceptance criteria and confirmed remote target-branch delivery before closure. An approved automatic closure may accompany the authorized delivery operation; the authorization does not waive completion requirements.

`ask-merge` 同时覆盖合并及相关异常处理，如 Actions 失败、仓库要求不满足或目标分支未收到交付；先准备并报告结果，再询问授权。`ask-close` 同样覆盖提交、推送或合并触发的自动关闭，仅有提交或合并授权不等于已授权关闭。所有 Issue 预设关闭前都要求范围及验收条件完成，并确认远端目标分支收到交付。已获授权的自动关闭可随已授权的交付操作发生，但授权不免除完成条件。

## Shared resources / 共享资源

Each preset keeps its complete workflow in its own prompt: Issue handling, branch choice, commit/push, merge, closure and authorization. Short repeated paragraphs are intentional so a preset can be read and edited in one place. All fourteen bundled presets are self-contained in both languages and do not include `_share/common.*.md`. That optional fragment remains available for custom specs, is never injected automatically, and must be checked for compatibility with their workflow. The bilingual JSON Issue templates remain shared through front matter. Nested includes are still supported for custom resources.

每个规范的 prompt 直接包含完整流程：Issue 操作、分支选择、提交推送、合并、关闭及授权策略。允许短段落重复，便于在一处阅读和修订。14 个内置预设的两种语言均自包含，不引用 `_share/common.*.md`。该可选片段保留供自定义规范使用，不会自动注入，引用时应核对其约定与所需流程是否一致。双语 JSON Issue 模板继续由 front matter 引用共享。自定义资源仍支持嵌套 include。
