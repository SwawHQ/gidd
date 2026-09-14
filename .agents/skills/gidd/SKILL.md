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
  gidd.link config set github.account SwawHQ    #(示例) 设置 github.account 的值为 SwawHQ
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
3. 命令概览：`gidd.pre.ensure.cmd --help`，`gidd.link.cmd --help`


## 五、停用

1. 针对仓库停用本技能，删除`<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`即可（后续仍可能触发是否启用 GIDD）
2. 完整卸载（所有仓库不再使用本技能）应包含：技能安装目录、`<仓库根>/.agents/skills/gidd/`目录和共享工具目录`~/.agents/skills.tools/gidd/`
