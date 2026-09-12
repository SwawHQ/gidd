---
name: gidd
description: 用 gh 命令操作 GitHub Issue、PR ... 用 GitHub Issue Driven Development 实现更规范、更可视-可审计的开发流程。目前仅支持 Windows
license: MIT
---

## 功能示例

```
.\.agents\skills\gidd\gidd.link.cmd --help
GIDD（Windows x64 / PowerShell 5.1）

帮助与诊断：
  gidd help en                           Show English help
  gidd help zh                           显示中文帮助
  gidd doctor                            检查工具、仓库及 GitHub 身份（含联网检查）
  gidd doctor --offline                  仅检查本地工具、配置和仓库，不联网

技能设置：
  gidd config show                       列出 config.toml 当前内容
  gidd config set <字段> <值>            设置 config.toml 中指定字段的值
  gidd config set github.account SwawHQ  (示例) 设置 github.account 的值为 SwawHQ
  config.toml 不存在时，config set 会创建最小配置；工具下载来源使用内置默认值。

GitHub 授权：
  gidd auth                              按配置申请设备授权并等待确认；gh 可能保存凭据

诊断结果：
  每项含 severity（info / warning / error）；按 hint 和 commands 修复后重新检查。
  退出码 0：无 error；1：存在 error；2：参数或执行异常。离线通过不代表 GitHub 已登录或可推送。
  commands 的 required_inputs 需补入真实值；auth 须获用户明确授权。
  配置字段：github.hostname/account/remote/repository、tools.node/bun/gh.source（HTTPS 下载根地址）。
  git.worktree 检查本地 Git 工作树及 HEAD；config_file 检查配置文件及结构。
  config.github.remote/hostname/repository/account 分别检查对应字段；前三项还检查与本地 fetch 目标是否匹配。
  config. 前缀仅用于检查项 ID；config set 仍使用 github.remote 等实际字段名。
  身份缺失或变化时先重审配置，再按建议命令设置 github.repository；不记录 commit 或独立 push 地址。
```

## 启用步骤

1. 确认`<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`已存在（不存在请跳到第 4 步）
2. 使用完整路径可在任意目录调用（仓库操作固定针对其所属仓库）：`gidd.link.cmd doctor --offline`查看诊断（命令若已损坏视同不存在，请跳到第 4 步）
3. 若退出码为 `0`，则可以执行`gidd.link.cmd --help`，按帮助使用其中介绍的功能，结束准备流程；否则按 doctor 提示的信息进行修复或配置（有些项目必须要人类协助）

4. `gidd.link.cmd`若不存在，请执行`gidd.pre.ensure.cmd --repo <仓库路径>`（此命令应存在于本技能的安装目录），它会确保有 JS运行时、Git、gh 可用，然后创建`<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`
5. `gidd.link.cmd`被创建后，运行`gidd.link.cmd doctor --offline`，按提示的信息进行修复或配置（有些项目必须要人类协助）
6. doctor 退出码为 `0`，视为通过, 则可以执行`gidd.link.cmd --help`按给出的提示和使用其中介绍的功能进行开发

## 配置与授权

 `github.hostname`、`github.account`、`github.remote`，核实生成的默认值，保留无关配置和注释。账号是预期登录身份，remote 是名称。`github.repository` 保存 doctor 给出的规范化 fetch 身份；缺失或变化时，先核对上述配置，再用 `config set` 记录。

用户明确要求登录时才执行 `auth`，读取配置中的主机和账号，展示本次 URL 和一次性代码，等待用户授权并验证实际账号；不自动打开浏览器，不在配置中保存凭据。

## 工具与文件管理

工具固定共用 `~/.agents/skills.tools/gidd/`，不提供路径覆盖。仓库级别停用本技能，不应删除 skills.tools/gidd/ 共享工具，明确的完整卸载则应包含它们。卸载范围按实际技能安装目录、仓库配置目录和共享工具目录确认；保留复用的外部工具，删除文件不代表撤销 GitHub 授权
