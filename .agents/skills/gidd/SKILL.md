---
name: gidd
description: 能基于 GitHub Issue Driven Development 实现更规范、更可视、更可监督与审计的开发流程；能便携化设置 JS运行时、Git 和 GitHub CLI（gh）。目前限 Windows
license: MIT
---

>仅需 JS运行时、Git 或 gh 时，按第二节操作即可；需要在目标仓库使用 GIDD 开发规范时，则按第三、四节操作

## 一、功能示例

```
.\.agents\skills\gidd\gidd.link.cmd --help
GIDD（Windows x64 / PowerShell 5.1）

  gidd.link help en                             #Show English help
  gidd.link help zh                             #显示中文帮助
  gidd.link doctor                              #检查工具、仓库及 GitHub 身份（含联网检查）
  gidd.link doctor --offline                    #仅检查本地工具、配置和仓库，不联网

  gidd.link config show                         #列出 config.toml 当前内容
  gidd.link config set <字段> <值>              #设置 config.toml 中指定字段的值
  gidd.link config set repo.remote.account bornwhy    #(示例) 设置 repo.remote.account 的值为 bornwhy
  gidd.link config set repo.remote.name origin #选择本地 remote
  gidd.link config set repo.remote.url https://github.com/swawhq/gidd #记录预期仓库
  gidd.link config set spec.mode issue-direct   #选择轻量规范

  gidd.link auth                                #按配置申请设备授权并等待确认；gh 可能保存凭据

  gidd.link spec                                #列出已有规范名称
  gidd.link spec --json --lang zh              #支持可选参数 --json、--lang zh|en，下同，不再赘述
  gidd.link spec.current                        #输出当前配置的规范
  gidd.link spec.issue-direct                   #输出指定规范，不改变当前配置
  gidd.link spec.current.issue                  #输出当前规范的 Issue 模板
  gidd.link spec.issue-direct.issue             #输出指定规范的 Issue 模板
  gidd.link spec.current.issue.check 123        #检查所属仓库的 GitHub Issue 正文
  gidd.link spec.current.issue.check ./issue.md #检查本地 Markdown 正文
```

仓库配置采用 `[repo]` 下的 `remote.name`、`remote.url`、`remote.account`，主机名从规范 HTTPS 仓库地址派生。旧 `[github]`、`hostname` 和 `[tools]` 不再支持。

`doctor` 逐字段报告本地配置与实际 remote 状态；`config.repo.remote.account..online` 核验 API 账号。`config.repo.remote.url..online` 在 `details.gh_remote_read` 中记录 gh 仓库信息读取及返回 URL 核验，在 `details.git_remote_read` 中记录 Git 远端引用读取，不另设子检查 ID。本地 remote 与配置 URL 的比对属于 `config.repo.remote.url`，不联网。离线或跳过的检查仍为未验证；SSH 读取暂不探测，`checks_incomplete` 表示警告而非全部在线通过。`auth` 要求三项仓库配置完整且本地 remote 匹配，不要求规范选择、Git 作者或已有提交。

`doctor.checks` 固定按 `tool.`、`folder.`、`config.` 三组排列，不按检查结果动态重排。工具项为 `tool.js_runtime`、`tool.git`、`tool.gh`（平台不受支持时，组首增加 `tool.platform`）；文件夹组包含 `folder.git.worktree`、`folder.git.author`；配置组从 `config.toml` 开始，依次列出三项 remote 字段和 `config.spec.mode`，最后列出账号、仓库地址的在线检查。`config.spec.mode` 同时检查规范名称及对应资源的完整性、有效性；资源缺失或损坏会直接使该项失败，并提供资源路径和修复提示。跨组依赖通过 `blocked_by` 指向对应 ID。

doctor 报告顶层的 `folder` 表示本次检查的本地目录路径。`hint` 按实际结果生成，有错误或警告时直接引用 `severity` 的 `error`、`warning` 值；离线和未完成的在线检查分别说明，且不宣称已核验推送权限。

## 二、仅使用便携化设置的工具

在本技能的安装目录，按需执行：
```
gidd.pre.ensure.cmd --tools-only=bun
gidd.pre.ensure.cmd --tools-only=node
gidd.pre.ensure.cmd --tools-only=git
gidd.pre.ensure.cmd --tools-only=gh
```
它会视情况是否需要下载/设置便携版，然后在`~/.agents/skills.tools/gidd/`对应生成工具包装：
```
bun.link.cmd
node.link.cmd
git.link.cmd
gh.link.cmd
```
以及可能的 `bun/`、`node/`、`git/`、`gh/` 目录。这些资源，按需使用便可，但不应该再手动修改。
命令概览：`gidd.pre.ensure.cmd --help`

## 三、GIDD 使用步骤

技能安装后，仍需对仓库进行单独的配置后，才会启用，详见`四、GIDD 启用步骤`

1. 确认`<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`已存在（不存在请跳到`四、GIDD 启用步骤`）
2. 可在任意目录调用`<path-to>/gidd.link.cmd doctor --offline`查看诊断（每个`gidd.link.cmd`都是动态生成，只会操作其自身所属的仓库，不应跨仓库混用）
3. 按诊断提示进行修复或配置（有些项目必须要人类协助），并再次运行诊断，直至其退出码为`0`，执行`gidd.link.cmd spec.current`，便可按输出的规范要求开展工作了
4. `gidd.link.cmd`若损坏，可执行`gidd.pre.ensure.cmd --repo <仓库路径>`重新创建（此命令应存在于本技能的安装目录）

## 四、GIDD 启用步骤

1. `<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`不存在时，需征询用户“是否启用 GIDD”，若否，则退出启用步骤
2. 执行`gidd.pre.ensure.cmd --repo <仓库路径>`，它会确保有 JS运行时、Git、gh 可用，并创建`<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`，然后可按`三、GIDD 使用步骤`进行操作
3. 前置准备不读取或创建 `config.toml`，不检查 remote 或账号；工具来源与版本策略由内部 PowerShell 模块维护。仓库配置缺失、损坏或没有 remote 时，仍可创建合法工作区的入口，再用 doctor 修复配置。
4. 命令概览：`gidd.pre.ensure.cmd --help`，`gidd.link.cmd --help`


## 五、停用

1. 针对仓库停用本技能，删除`<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`即可（后续仍可能触发是否启用 GIDD）
2. 完整卸载（所有仓库不再使用本技能）应包含：技能安装目录、`<仓库根>/.agents/skills/gidd/`目录和共享工具目录`~/.agents/skills.tools/gidd/`
