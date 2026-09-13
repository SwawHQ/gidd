---
name: gidd
description: 用 gh 命令操作 Issue、PR... 用 GitHub Issue Driven Development 实现更规范、更可视-可审计的开发流程。目前限 Windows
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

仓库开发规范：
  gidd spec                             打印当前生效规范和可用 helper（离线只读）
  gidd spec current                     显式写法，与 gidd spec 相同
  gidd spec --lang zh                    指定中文输出；也支持 en
  gidd spec template issue               打印当前规范的 Issue 模板
  spec、spec current 和 spec template issue 均支持 --json、--lang zh|en。
  当前可选模式：issue-direct（Issue + 直接交付，不要求 PR 或独立审批）。
  规范指引不代表远程权限已验证；Git/gh 原生命令不会自动执行规范检查。

技能设置：
  gidd config show                       列出 config.toml 当前内容
  gidd config set <字段> <值>            设置 config.toml 中指定字段的值
  gidd config set github.account SwawHQ  (示例) 设置 github.account 的值为 SwawHQ
  gidd config set spec.mode issue-direct  选择轻量规范
  config.toml 不存在时，config set 会创建最小配置；工具下载来源使用内置默认值。

GitHub 授权：
  gidd auth                              按配置申请设备授权并等待确认；gh 可能保存凭据

诊断结果：
  每项含 severity（info / warning / error）；按 hint 和 commands 修复后重新检查。
  退出码 0：无 error；1：存在 error；2：参数或执行异常。离线通过不代表 GitHub 已登录或可推送。
  commands 的 required_inputs 需补入真实值；auth 须获用户明确授权。
  配置字段：github.hostname/account/remote/repository、tools.node/bun/gh.source（HTTPS 下载根地址）、spec.mode。
  git.worktree 检查本地 Git 工作树及 HEAD；config_file 检查配置文件及结构。
  config.github.remote/hostname/repository/account 分别检查对应字段；前三项还检查与本地 fetch 目标是否匹配。
  config. 前缀仅用于检查项 ID；config set 仍使用 github.remote 等实际字段名。
  身份缺失或变化时先重审配置，再按建议命令设置 github.repository；不记录 commit 或独立 push 地址。
  config.spec.mode 检查模式选择；spec.resources 检查该模式的定义及必要资源。
```

## 启用步骤

1. 确认`<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`已存在（不存在请跳到第 5 步）
2. 可在任意目录调用`<path-to>/gidd.link.cmd doctor --offline`查看诊断；每个`gidd.link.cmd`都是动态生成，只会操作其自身所属的仓库（不应跨仓库混用）
3. 若退出码为`0`，执行`gidd.link.cmd spec`，便可按输出的规范要求和 helper 开展工作了；否则按提示的信息进行修复或配置（有些项目必须要人类协助）
4. `gidd.link.cmd`若损坏，可执行`gidd.pre.ensure.cmd --repo <仓库路径>`重新创建（此命令应存在于本技能的安装目录）

5. `gidd.link.cmd`不存在时，需征询用户“是否启用 GIDD”，若否，则退出启用步骤
6. 执行`gidd.pre.ensure.cmd --repo <仓库路径>`，它会确保有 JS运行时、Git、gh 可用，然后创建`<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`
7. `gidd.link.cmd`被创建后，运行`gidd.link.cmd doctor --offline`，按提示的信息进行修复或配置（有些项目必须要人类协助）
8. 退出码为`0`才视为通过, 执行`gidd.link.cmd spec`便可按输出的规范要求和 helper 开展工作了

9. 帮助信息：`gidd.pre.ensure.cmd --help`，`gidd.link.cmd --help`


## 停用

1. 仅停用本技能，删除`<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`即可；
2. 完整卸载应包含：技能安装目录、`<仓库根>/.agents/skills/gidd/`目录和共享工具目录`~/.agents/skills.tools/gidd/`
