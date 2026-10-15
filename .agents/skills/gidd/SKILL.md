---
name: gidd
description: 基于 Git Worktree、GitHub Issue 为要求可审计（过程留痕）、外包式（先立验收契约再开发）、多任务并行、流水线式协作的开发，提供任务登记、工作区管理/交付等工具，自带 git、gh（GitHub CLI）、bun/node 准备；适用于 Git/GitHub 操作-如 clone、Issue、PR 或用户提及 gidd 时。
license: MIT
---

## 准备

`gidd.cmd` 和 `tools.ensure.cmd` 位于技能安装目录，通过安装路径调用。下文用 `gidd` 简写 `gidd.cmd`。`gidd help` 和 `tools.ensure.cmd help` 提供命令用法。

`gidd doctor --offline` 检查本地环境；`tools.ensure.cmd` 准备或修复 Git、gh 和 JS 运行时。GIDD 缺少运行时入口时会自动准备基础工具，可能下载资源。

`gidd git`、`gidd gh`、`gidd bun` 和 `gidd node` 调用已准备的工具，转发参数、输入输出和退出码，保留当前目录。

GIDD 沿用 Git 的远端配置，优先使用 `for.swaw.gidd` 远端。`gidd gh.auth` 通过交互登录，为当前仓库选择 GitHub 账号。

## 工作流程

工作流程由交付模式和授权方案组成。每种交付模式提供多种授权方案。

- `gidd flow.deliveries`：列出交付模式，包括直接提交、直接合并和 PR 合并。
- `gidd flow.list 00`：列出 `00` 号交付模式下的授权方案。
- `gidd flow 00/05`：查看 `00` 号交付模式与 `05` 号授权方案组成的工作流程。
- `gidd flow.issue 00/05`：查看该工作流程的 Issue 模板。
- `gidd flow.history`：查看工作流程选用记录。

授权方案指定哪些步骤自动执行、哪些步骤需要确认。它用于生成 Agent 执行提示；GIDD 命令本身不会弹出步骤授权确认。配置说明见 [工作流程配置](flows/README.md)。

## 任务与工作区

`gidd issue --file <文件> --flow <工作流程>` 从 Markdown 创建 Issue、登记任务并准备工作区。`gidd <Issue编号> --flow <工作流程>` 登记已有 Issue，并准备或恢复工作区。

两个命令均返回任务工作区路径。直接提交模式使用目标仓库目录；直接合并和 PR 合并模式领用专用工作树。

- `gidd <Issue编号>`：查看任务和工作区状态。
- `gidd <Issue编号>.flow`：查看任务保存的工作流程。
- `gidd <Issue编号>.flow.set <工作流程>`：修改任务的工作流程。
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
