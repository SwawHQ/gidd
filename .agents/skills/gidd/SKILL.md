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
  gidd.link config set git.credential.mode gh   #必填 gh|inherit；gh 仅配置 HTTPS 凭据助手
  gidd.link config set git.user.name "提交署名"   #与 git.user.email 成对设置，或均省略
  gidd.link config set git.user.email "name@example.com"

  gidd.link auth                                #按配置申请设备授权并等待确认；gh 可能保存凭据
  gidd.link .gh issue list                      #按配置预设 GitHub 账号和仓库；原始参数透传
  gidd.link .git status                         #按配置预设 Git 环境；本地操作不要求登录

  gidd.link spec                                #列出已有规范名称（JSON）
  gidd.link spec --lang zh                      #可选参数 --lang zh|en；下同
  gidd.link spec.current                        #输出当前规范的 Markdown 流程提示
  gidd.link spec.issue-direct                   #输出指定规范的 Markdown 流程提示
  gidd.link spec.current.issue                  #输出当前规范的 GitHub Issue 表单（JSON）
  gidd.link spec.issue-direct.issue             #输出指定规范的 GitHub Issue 表单（JSON）
```


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
2. 可在任意目录调用`<path-to>/gidd.link.cmd doctor --offline`查看诊断（每个入口默认使用自身所属仓库的配置及工作目录；`.gh`/`.git` 的显式参数按原生命令规则覆盖）
3. 按诊断提示进行修复或配置（有些项目必须要人类协助），并再次运行诊断，直至其退出码为`0`，执行`gidd.link.cmd spec.current`，便可按输出的规范要求开展工作了
4. `gidd.link.cmd`若损坏，可执行`gidd.pre.ensure.cmd --repo <仓库路径>`重新创建（此命令应存在于本技能的安装目录）
5. 开发时通过该仓库的 `gidd.link.cmd .gh`、`.git` 使用工具。它们准备默认执行环境，不拦截目标参数或强制执行开发规范。配置、优先级和认证说明见 [execution.md](execution.md)。

## 四、GIDD 启用步骤

1. `<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`不存在时，需征询用户“是否启用 GIDD”，若否，则退出启用步骤
2. 执行`gidd.pre.ensure.cmd --repo <仓库路径>`，它会确保有 JS运行时、Git、gh 可用，并创建`<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`，然后可按`三、GIDD 使用步骤`进行操作
3. 前置准备不读取或创建 `config.toml`，不检查 remote 或账号；工具来源与版本策略由内部 PowerShell 模块维护。仓库配置缺失、损坏或没有 remote 时，仍可创建合法工作区的入口，再用 doctor 修复配置。
4. 命令概览：`gidd.pre.ensure.cmd --help`，`gidd.link.cmd --help`


## 五、停用

1. 针对仓库停用本技能，删除`<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`即可（后续仍可能触发是否启用 GIDD）
2. 完整卸载（所有仓库不再使用本技能）应包含：技能安装目录、`<仓库根>/.agents/skills/gidd/`目录和共享工具目录`~/.agents/skills.tools/gidd/`

## 命令帮助

- gidd.link：[中文](references/gidd.link.help.zh-CN.md) / [English](references/gidd.link.help.en.md)
- gidd.pre.ensure：[中文](references/gidd.pre.ensure.help.zh-CN.md) / [English](references/gidd.pre.ensure.help.en.md)
