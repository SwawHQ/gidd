---
name: gidd
description: 为指定 Git 仓库准备或检查 GIDD、编辑 GitHub 配置、诊断身份，并按用户明确要求进行登录授权。当前支持 Windows；初始化及 Issue/PR 业务尚未实现。
license: MIT
---

# GIDD

按用户请求确定目标 Git 工作树。只检查时不准备工具或写配置；技能、入口和配置存在不代表启用仓库开发流程。

当前已验证 Windows x64 / PowerShell 5.1。`config init`、初始化归属记录、doctor 评级、`gidd.link.sh` 和 Issue/PR 业务尚未实现，不要执行或模拟这些能力。

## 仓库入口流程

入口固定为 `<目标仓库根>/.agents/skills/gidd/gidd.link.cmd`，配置为同目录的 `config.toml`，不继承用户级配置。下文的 `gidd.link.cmd` 均指该入口的绝对路径，可从任意工作目录调用，不能改指其他仓库。

1. **已有入口先诊断。** 执行 `gidd.link.cmd doctor --offline`。取得完整 JSON、退出码为 `0` 且 `status=local_ready`，才进入第 4 步；不能仅凭输出没有 `error` 放行。链接无法启动时转第 2 步，诊断报告问题时转第 3 步。

2. **缺失或失效时准备。** 从实际技能安装目录执行：

   ```powershell
   & "<技能安装目录>\gidd.pre.ensure.cmd" --repo "<目标仓库根>"
   ```

   `--repo` 必填，目标必须已有 Git 工作树和合适的 GitHub remote。命令准备 JS 运行时、Git、gh 和仓库入口，复用健康工具及已有配置。仅检查时追加 `--check`；`help zh` 无需仓库或运行时。按失败原因处理，保留未知文件。

3. **按问题配置或修复。** 当前用 `config show/set` 补齐 `github.hostname`、`github.account`、`github.remote`，核实模板默认值，保留无关配置和注释。账号是预期登录身份，remote 是名称，不是 URL。工具问题返回准备入口；工作树、作者和 remote 问题按 Git 诊断处理。完成后重新执行第 1 步。详见 [配置协议](references/configuration.md)。

4. **本地就绪后查看帮助。** 执行 `gidd.link.cmd --help` 或 `help zh`。首次 GitHub 操作前再执行普通 `doctor`；离线通过不证明登录或推送权限。API 身份、Git 传输和 commit 作者分别判断，网络失败不等于未登录。详见 [doctor 协议](references/doctor.md)。

仓库内 `.agents/skills/gidd/` 或 `.claude/skills/gidd/` 安装只能指定所属工作树；Git 树外共享安装可指定目标，Git 树内布局不明则报错。链接规则及恢复方式见 [仓库专用入口](references/repository-entry.md)。

## 待实现的初始化约定

新建入口、配置缺失、初始化未完成或归属不匹配时，目标流程是 `config init`，完成后仍回到离线诊断。当前仅编辑配置，不写初始化字段或宣称初始化完成。

计划中的初始化幂等且无交互，支持分段输入并报告缺项；明确账号、选择 remote，记录一条规范化 GitHub 仓库身份。草稿写入 `config.toml.temp`，全部校验后原子替换正式配置，保留已有有效信息。doctor 将新增 `severity=info|warning|error`，完整诊断无 `error` 才继续；当前仍按 `local_ready` 判断。

## 登录授权

检查登录使用 `doctor`；用户明确要求登录时才执行 `auth`，读取配置中的主机和账号。复用匹配身份，不自动切换账号。展示本次 URL 和一次性代码，等待用户授权并验证实际账号；不自动打开浏览器，不在配置中保存凭据。见 [授权协议](references/authorization.md)。

## 工具与文件管理

工具固定共用 `~/.agents/skills.tools/gidd/`，不提供路径覆盖。运行时选择和强制修复见 [准备协议](references/bootstrap.md)，完整性与清理见 [安装协议](references/setup.md)。

复制技能时排除 `config.toml`、`config.toml.*`、`gidd.link.cmd` 及 `gidd.link.cmd.*`，保留目标配置；当前模板仍是 `config.example.toml`。仅卸载一个仓库不得自动删除共享工具，完整卸载须明确包含它们；不得删除复用的外部工具，也不能把删除文件当作撤销 GitHub 授权。
