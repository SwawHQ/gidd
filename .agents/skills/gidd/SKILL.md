---
name: gidd
description: 可便携化设置-提供 node、bun、git 和 gh(GitHub CLI)；操作本地仓库/Github平台/issue/PR...；基于 GIDD（GitHub Issue Driven Development）提供更安全可控的开发流程。目前限 Windows
license: MIT
---

## 一、仅借用共享工具

检查 `~/.agents/skills.tools/gidd/` 是否存在，及其中是否有：

```text
bun.link.cmd    #bun  包装，参数会原样转发给 bun  去执行
node.link.cmd   #node 包装，参数会原样转发给 node 去执行
git.link.cmd    #git  包装…
gh.link.cmd     #gh   包装…
```

如果已存在 `<你需要的命令>.link.cmd`，便可以自行使用。

否则在本技能的安装目录，按需执行：

```text
gidd.pre.ensure.cmd --tools-only=bun
gidd.pre.ensure.cmd --tools-only=node
gidd.pre.ensure.cmd --tools-only=git
gidd.pre.ensure.cmd --tools-only=gh
```

它会视情况是否需要下载/设置便携版，然后生成对应命令的包装。

命令概览：`gidd.pre.ensure.cmd --help`

## 二、GIDD 使用步骤

> 仅需 node、bun、git 或 gh 时，按上面第一节操作即可；
> 有意启用 GIDD 时，才需按本节或下面的第三节操作

1. 确认 `<目标仓库根>/.agents/skills/gidd/gidd.link.cmd` 是否已存在（若不存在表示仓库还未经配置，请跳到“三、GIDD 启用步骤”）
2. 在 `<目标仓库根>` 下调用 `./.agents/skills/gidd/gidd.link.cmd doctor --offline` 查看诊断（`gidd.link.cmd` 会检查自身所归属的仓库，勿跨仓库混用）；可用 `--lang zh|en` 指定语言，否则依次取 `GIDD_LANG`、系统语言。检查开关和双语诊断提示见 [doctor.toml](references/doctor.toml)，禁用或未声明的检查不代表通过
3. 按诊断的提示进行配置或修复（有些必须要人类协助）并再次运行诊断，直至其退出码为 `0`，执行 `gidd.link.cmd spec.current`，便可按其输出的指引开展工作了
4. `gidd.link.cmd` 若损坏，执行 `gidd.pre.ensure.cmd --repo <仓库路径>` 可重新创建

`config.toml` 和生成的 `gidd.link.cmd` 是本机文件，由初始化生成的 `.gitignore` 忽略。开发流程以 Issue 为入口；workflow 命令通过 Issue 编号定位本地工作区；首次准备按当前规范和目标仓库当前分支确定交付上下文，worktree 命令按目录查询和移除本机资源。本地数据目录固定为 `<目标仓库>.gidd/`，关联 worktree 共用；目录检查及维护见 [本地数据目录](references/data.md)。

## 三、GIDD 启用步骤

仓库需明确配置后，GIDD 才会启用；仅安装技能不会插手仓库的开发流程。

1. `<目标仓库根>/.agents/skills/gidd/gidd.link.cmd` 不存在时，需征询用户“是否启用 GIDD”，若否，则终止本流程
2. 执行 `gidd.pre.ensure.cmd --repo <仓库路径>`，它会准备 JS运行时、git、gh，创建仓库的 `gidd.link.cmd`，并自动调用初始化，创建基础配置和本地数据目录。初始化失败时按原因修复，再运行 `gidd.link init` 重试；随后按“二、GIDD 使用步骤”完成其余配置
3. 命令概览：`gidd.link.cmd --help`

## 四、处理外部 Issue/PR

多半是用户要处理其它 GitHub 用户提交的 Issue/PR

若对应仓库已有本地镜像，可用 `<本地仓库根>/.agents/skills/gidd/gidd.link.cmd`（此时不必死守 `gidd.link.cmd spec.current`，自行依情况处理）：

```text
gidd.link .gh <gh 原生参数>   #按配置提供环境：账号-token/GH_HOST/GH_REPO/Git(优先级< 参数指定)后,转发 gh
gidd.link .git <git 原生参数> #按配置提供环境：身份/HTTPS-凭据助手(优先级>.git/config < 参数)后,转发 git
```

或用 `~/.agents/skills.tools/gidd/` 中的工具（自行确认权限和组装账号、身份等环境参数）

仓库的 `.git` / `.gh` 沿用入口配置，仅允许从入口仓库及 `workflow.workspace` 登记的关联 worktree（含普通子目录）调用。显式目标参数按原生语义处理，由调用者确认操作范围；指定其他仓库仍沿用原入口的身份和凭据设置。

包装禁用常见交互：提供消息、文件和必要参数；编辑器或凭据询问会失败，正常管道输入保留。仅 `.gh.auth` 发起设备授权。可用 `GIDD_EXEC_TIMEOUT_MS` 限制转发命令时长（毫秒，默认不限时，超时退出 124）；自定义程序的边界见 [执行说明](execution.md)。共享工具的 `.link.cmd` 不应用这些仓库包装策略。

若需克隆，得确定放置位置，视情况是否要询问人类用户

## 五、处理更广泛的 GitHub 平台事务

对指定的在线仓库提 Issue/PR？帮用户自己检查/设置 GitHub？……是用户自己的仓库？或是需要先 fork？……

请自行依情况处理；若需克隆，得确定放置位置，视情况是否要询问人类用户

## 六、停用

参考 [停用说明](references/disable.md)。
