---
name: gidd
description: 基于 Git Worktree、GitHub Issue 为要求可审计（过程留痕）、外包式（先立验收契约再开发）、多任务并行、流水线式协作的开发，提供任务登记、工作区管理/交付等工具，自带 git、gh（GitHub CLI）、bun/node 准备；适用于 Git/GitHub 操作-如 clone、Issue、PR 或 gidd 被提及时。
license: MIT
---

## 准备

技能安装目录应存在`gidd.cmd`和`tools.ensure.cmd`命令入口，可以`path/to/gidd/gidd help`、`path/to/gidd/tools.ensure help`查看用法。

使用前先执行一次`gidd doctor --offline`确认环境ok，初次执行会自动准备 git、gh、bun/node（可能下载资源），要手动准备或修复时请使用`tools.ensure.cmd`。

gidd 的相关子命令会沿用 git 设置，只是若存在名为 for.swaw.gidd 的远端会优先应用；gh 账号，则需在仓库中执行一次`gidd gh.auth`请求单独指定授权（需要交互）



## 授权方案

Git/GitHub 功能繁多，gidd 预设了一些授权方案（包含`交付模式`和`步骤授权`），以帮助简化与用户的对齐。

授权方案按交付模式分组。

- `gidd policy.deliveries`：列出交付模式，例如`00.direct-commit`。
- `gidd policy.list 00`：列出 `00` 号交付模式下的授权方案。
- `gidd policy 00/05`：查看`00`号交付模式下的`05`号授权方案。
- `gidd policy.issue 00/05`：查看该授权方案的 Issue 模板。
- `gidd policy.history`：查看授权方案选用记录。

授权方案指定哪些步骤自动执行、哪些步骤需要确认。它用于生成 Agent 执行提示；GIDD 命令本身不会弹出步骤授权确认。配置说明见 [授权方案配置](policies/README.md)。

## 任务与工作区

`gidd issue --file <文件> --policy <授权方案>` 从 Markdown 创建 Issue、登记任务并准备工作区。`gidd <Issue编号> --policy <授权方案>` 登记已有 Issue，并准备或恢复工作区。

两个命令均返回任务工作区路径。直接提交模式使用目标仓库目录；直接合并和 PR 合并模式领用专用工作树。

- `gidd <Issue编号>`：查看任务和工作区状态。
- `gidd <Issue编号>.policy`：查看任务保存的授权方案。
- `gidd <Issue编号>.policy.set <授权方案>`：修改任务的授权方案。
- 任务交付：编号命令提供推送、合并、目标分支同步、关闭 Issue 和清理功能。
- 工作树管理：`gidd worktree.list`、`gidd worktree.show <目录>` 和 `gidd worktree.remove <目录>` 提供查询和移除已释放工作区的功能。
- 输出语言：`gidd lang.set zh|en` 设置全局默认语言。

## 仓库与账号

`gidd gh.auth` 的配置保存在 `<目标仓库>.gidd/gh/`。任务命令使用登记时保存的账号；`gidd gh` 使用当前目录对应配置中的当前账号，保留显式的 `GH_CONFIG_DIR` 和令牌环境变量，`--repo` 不改变配置目录。Git 使用原有身份与凭据。

## 详细帮助

- [命令与参数](references/gidd.help.zh-CN.md)：任务、交付和工具命令。
- [工具准备参数](references/tools.ensure.help.zh-CN.md)：准备、检查和修复工具。
- [本地数据目录](references/data.md)：任务记录、工作树、恢复与清理。
- [卸载与清理](references/disable.md)：技能、共享工具和本地数据的移除说明。
