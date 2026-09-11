# GIDD 开发规则

## Scope

本文件适用于 `SwawHQ/gidd` 仓库。以下为已确认的开发约束，不表示功能已经实现。

- **目标仓库**：用户要求启用 GIDD 并进行开发的 Git 仓库。
- **技能安装目录**：实际包含 GIDD `SKILL.md` 和配套脚本的目录，可以位于用户技能目录或目标仓库的 `.agents/skills/gidd/`。
- **仓库配置文件**：固定为 `<目标仓库>/.agents/skills/gidd/config.toml`，与技能安装范围无关。
- **用户技能根目录**：由 Agent 客户端自行决定；技能安装位置及用户级/仓库级模式不写入 GIDD 配置，也不参与下载工具路径解析。
- **工具目录**：永久固定为 `~/.agents/skills.tools/gidd/`，`~` 指当前用户家目录。技能与开发入口共用该位置；这是跨仓库共享约定，不是可覆盖的默认值，不提供配置、命令行或专用环境变量来定制安装位置；规则见 `.agents/skills/gidd/references/configuration.md`。
- 本项目的 `.agents/skills/gidd/` 是唯一技能源码目录，同时采用仓库安装布局；入口可直接定位本仓库。目录及配置存在不代表启用本项目自身的 GIDD 流程。迁移由 Issue #16 跟踪。
- `.agents/skills/gidd/config.toml` 是本仓库实例，保留并单独审阅；发布或复制技能到其他仓库时排除它及 `config.toml.*` 编辑临时文件，使用 `config.example.toml` 创建目标配置并保留已有实例。下载数据只在固定共享工具目录，完整安装/更新流程由 Issue #14 跟踪。

## Accepted

1. **GIDD-001 — 产品与交付边界。** `.agents/skills/gidd/SKILL.md` 组织 GitHub Issue、关联分支、Draft PR、本地验证、review 和人工 merge；Issue 与 PR 保存工作目标和交付证据，不另建任务状态数据库。公开技能和脚本不得依赖 `ghswaw.cmd`、`swaw-kit` 安装目录或开发者机器的绝对路径。

2. **GIDD-002 — 对话管理与显式启用。** GIDD 的安装、初始化和管理以用户与 Agent 的对话为入口；例如“当前仓库启用 GIDD”“检查此仓库的 GitHub 登录”。安装到用户目录只提供技能，不启用任何仓库。用户明确要求启用某个目标仓库后，Agent 才执行该仓库的初始化；再次初始化应复用有效配置并补齐缺项，不重复登录或重建开发任务。底层脚本提供可验证的操作与结果，首版不另做面向人类的交互式配置向导。

3. **GIDD-003 — 配置唯一且具体归属。** 运行配置 `config.toml` 只保存在 `<目标仓库>/.agents/skills/gidd/`；用户级技能安装目录，若出现 GIDD `config.toml` 属于未定义行为，如何使用看用户如何提示；`config.toml` 不会自动继承或多层覆盖。用户级技能服务的目标仓库也使用上述固定路径；该目录只有配置文件时，不代表已安装完整技能。`config.toml` 使用注释解释字段，允许人类直接编辑，Agent 修改时保留无关字段和注释。工具配置 schema v1 已确定为 `schema_version` 与 tools 下的 node/bun 内联表（source）及 gh 内联表（version、source）；同一 schema 可选增加 [github] 表（hostname、account、remote），模板见 `.agents/skills/gidd/config.example.toml`。启用记录仍未定义，不能凭配置存在执行治理流程。

4. **GIDD-004 — 认证由授权事实确认。** `config.toml` 可以记录预期 GitHub 主机与账号，不保存 token、密码或二次验证码；修改账号字段不能视作已登录。有人参与的 gh 登录统一展示本次认证返回的 URL 和一次性用户代码，不自动打开浏览器，由用户在任意设备完成授权；脚本等待并验证实际身份后才报告成功。GitHub API 认证、Git 传输认证和 commit 作者信息分别检查。无 GUI 环境也采用该流程；长期凭据的保存位置由选定认证方式决定，不承诺复制配置即可复制登录状态。

5. **GIDD-005 — 实现与规则保持精简。** `.agents/skills/gidd/scripts/` 业务代码使用 JavaScript，Node.js 与 Bun 均为支持目标，只使用双方支持的标准 API，同一功能须在两种运行时验证。已确认的目标边界为：系统原生 Shell 仅承担显式 bootstrap，读取下载来源、寻找或准备 Bun/Node，调用独立 JS 兼容检查后发布共享 js_exec.cmd；普通 gidd.cmd 通过该启动器直接执行 JS，不调用 PowerShell 或兼容检查；完整 doctor、配置编辑、gh 准备与 GitHub 业务归 JavaScript。首次运行时下载所需的校验、锁和中断恢复仍由 stage0 负责；具体协议及迁移状态见 `.agents/skills/gidd/references/bootstrap.md`。不预先宣称未经测试的运行时或平台兼容性。规则应指明文件、目录、命令或其他具体实体；涉及交互原则时给出使用例子。源码、发布物和本地下载数据必须区分，README 由维护者维护。不得把尚未实现的初始化或治理能力表述为可用。PowerShell 源文件仅使用 ASCII 字符，保存为 UTF-8 无 BOM；开发测试集中检查 ASCII 内容与语法。中文说明放在文档或资源文件中，运行时仍支持 Unicode 数据。

6. **GIDD-006 — 工具集中存储与清理。** 已有可用的 Bun、gh 优先复用；需要 GIDD 下载工具或 bootstrap --yes 发布共享启动器时才建立实际工具目录；工具目录固定为 `~/.agents/skills.tools/gidd/`，不提供配置或命令行覆盖。Bun、Node、gh 分别保存在工具根的 `bun/`、`node/`、`gh/` 下，Node 可由技能入口 `gidd.cmd setup node` 或仓库开发入口准备。该目录只管理 GIDD 下载的工具、生成的 js_exec.cmd 及配套安装数据，不保存 GIDD `config.toml`；目录及全部子目录不得包含 `SKILL.md`。其中 `INSTALLATION.md` 说明用途、工具来源和清理方式，供人类及 Agent 主动读取。建立共享工具目录不代表安装用户级技能或启用任何仓库。收到卸载请求时，GIDD 管理流程检查 Agent 确认的技能实际安装目录、仓库配置文件、固定共享工具目录，展示清理范围；仅卸载当前仓库不得自动删除共享工具，无法确认其他仓库是否使用时不得声称工具已无引用。完整卸载须明确包含共享工具；不得删除复用的外部工具，也不得将删除文件表述为退出 GitHub 或撤销授权。

- **GIDD-008 — 显式 bootstrap 与共享启动器。** gidd.cmd bootstrap 默认只读；--yes 才允许下载、修复和发布 ~/.agents/skills.tools/gidd/js_exec.cmd。选择顺序固定为受管 Bun、受管 Node、PATH Bun、PATH Node；受管文件先验证完整性，再运行独立 JS 兼容方法。无兼容候选时默认准备稳定 Bun，--node 选择/准备 Node LTS 并更新所有仓库共用的启动器。普通 gidd.cmd 不读配置或探测运行时，直接将当前技能脚本和参数交给 js_exec.cmd；启动器不绑定仓库、不回退重跑业务。兼容性只在 bootstrap 和开发测试检查，技能更新后重新 bootstrap。健康安装复用，显式修复须先验证新副本、保留旧目录到启动器发布成功；未知文件/安装记录保留。没有 --yes 不生成启动器。最低版本与偏好不写配置，实际版本记入安装记录。详见 .agents/skills/gidd/references/bootstrap.md；Linux/macOS 尚未实现或验证。

## Open

- **GIDD-007 — Git 与更新边界。** 需确定仓库内技能源码、`config.toml` 和本地数据各自的提交策略，以及技能更新如何保留配置和下载数据。不要把整个 `.agents/` 默认视为应提交或应忽略。首次空基线已建立；后续修订通过 Issue 关联分支和 PR 审阅。

## Maintainer Notes

以下记录当前可执行实现；共用 JS 迁移由 Issue #21、显式 bootstrap 与共享启动器由 Issue #23 跟踪。兼容规则只在 scripts/runtime-compat.mjs 维护，由 bootstrap 及开发测试调用；普通命令不检查兼容性。

- 维护本源码仓库时，先查看 PATH 中的 `ghbw.cmd --help`，通过该入口访问 GitHub；先创建 Issue，再创建其关联分支，修订和验证后提交 PR，由人工 merge。`ghbw.cmd` 仅是本仓库维护所用的身份入口，不得成为公开 GIDD 技能或产品脚本的依赖。

- `gidd.cmd config show` 只读展示配置，`config set <字段> <值>` 支持 github.hostname/account/remote、node/bun/gh 的 source 及 gh.version；完整命令及原子写入协议见 `.agents/skills/gidd/references/configuration.md`。编辑逻辑在 `.agents/skills/gidd/scripts/config.mjs`，需要 Node/Bun 任一种；首次 set 生成模板，已有文件保留注释、无关字段和内联表的另一字段；写入前直接使用共用 JavaScript schema 校验，不回调 PowerShell。未知字段与 schema_version 不可设置，修改不安装、升级或迁移工具。配置编辑直接使用共享启动器；旧 [bootstrap] 与 Bun/Node version 字段须移除，否则报 config_retired_field。gh 仍遵守配置版本。help 按用途分组，说明紧跟命令同行，只列常用设置示例；完整字段与详细协议放入 references。schema v1 增加可选 `[github]` 表；identity 必须从文件读取 hostname/account/remote，auth 必须读取 hostname/account。运行时不补默认值，不允许命令参数覆盖；`dev.cmd .auth` 同样只读配置。配置修改不代表登录或启用，完整安装与迁移继续由 #14 跟踪。

- `dev.cmd .setup bun`、`.setup node`、`.setup gh` 分别准备指定工具，共用技能安装代码及仓库工具配置；`.setup gh` 使用已发布的共享启动器，由 JavaScript 安装 gh，不发起登录。安装只支持按配置联网下载或复用已有工具，不接受本地安装包目录；实际安装位置固定为 `~/.agents/skills.tools/gidd/`。

- 开发前先看 `dev.cmd .help zh` 和 `DEVELOPMENT.md`。运行命令/脚本使用 `dev.cmd bun ...` 或 `dev.cmd node ...`，默认只用共享目录中的便携版本；显式 `dev.cmd sys bun ...` / `dev.cmd sys node ...` 只搜索 PATH，两种模式互不回退。不手写开发者机器的运行时路径。日常验证用 `dev.cmd .test <测试组>`；提交前用完整 `.test` 做 Node/Bun 双运行时验收。`.auth` 是会保存 gh 凭据的真实授权快捷入口，不是离线测试；普通测试不得触发它。统一技能入口由 Issue #12 跟踪：Windows 的 .agents/skills/gidd/gidd.cmd 仅将 bootstrap 路由至 PowerShell，其余命令直接交给共享 js_exec.cmd；完整 doctor、配置编辑、工具准备、身份检查和授权调用共用 JavaScript。仓库内 .agents/skills/gidd/ 的入口从自身位置与 .git 标记定位目标（含 worktree）；本仓库直接调用无需额外参数，开发和测试仅在指定其他目标时使用内部参数 --repository；公开 help 与技能使用说明不暴露此参数。help 支持 --help、-h 别名；setup bun、setup node、setup gh 分别准备指定工具，identity/auth 不自动准备运行时或 gh。完整安装与固定共享工具路径迁移由 Issue #14 跟踪，schema v1 增加 github 表，工具来源与 gh 版本可配置，Bun/Node 版本和偏好不配置，目录固定共享。dev.cmd .auth 转发同一分发器；入口测试用 dev.cmd .test entry。Linux/macOS 启动器待验证后提供。

- 仓库开发入口为根 `dev.cmd`，用法见 `DEVELOPMENT.md`。`dev/` 和 `tests/` 属于仓库开发工具；`.setup` 准备 Bun 和 Node，`.test` 分别在两种运行时执行同一套 JavaScript 用例，Windows 辅助仅保留被测 PowerShell 接口与 fixture 构造。开发 Node 已验证版本清单位于 `dev/runtimes.json`，仅提取运行时和许可证，不附带 npm。工具固定存放于 `~/.agents/skills.tools/gidd/`，来源与 gh 版本读取仓库内联配置，Bun/Node 下载策略由内部维护；测试通过临时 USERPROFILE 隔离并在结束后恢复，worker 内用例串行；产品脚本的 Node/Bun 双运行时约束不变，技能工具初始化仍只要求其中一种运行时可用。

- 当前实现 Windows x64 / Windows PowerShell 5.1 基础 doctor 与便携 Bun/Node/gh 工具初始化，包含完整性校验、独占锁和中断后重试；工具配置读取、缺失工具的稳定版本解析与官方 SHA-256 校验已实现；已有健康工具继续复用，gh 固定版本冲突保留并报错；bootstrap --yes 可修复归属明确的运行时，--reinstall --yes 可显式重装，发布失败恢复旧安装。显式 config show/set 已实现；后台自动升级、gh 升级/回滚、完整技能安装更新、启用记录及 Issue/PR 业务脚本尚未实现。根 package.json 用于仓库开发测试。
- GIDD 自有代码和技能文档采用根 LICENSE 的 MIT 许可证；第三方下载工具保留各自许可证。结构整理由 Issue #1 跟踪，Windows doctor 由 Issue #2 跟踪。
- 本地测试结果、耗时与复跑提示由 Issue #10 跟踪；只读 GitHub 身份检查由 Issue #11 跟踪，入口为 `.agents/skills/gidd/gidd.cmd identity`，旧 check-identity.ps1 仅转发；业务逻辑在 `.agents/skills/gidd/scripts/github.mjs`，协议见 `.agents/skills/gidd/references/identity.md`。预期主机/账号只读取 config.toml 的 github.hostname/account，identity 另需 github.remote；API 身份、Git 远程读取和 commit 作者分开报告，读取成功不代表 Git 推送认证通过；显式设备授权入口为 `.agents/skills/gidd/gidd.cmd auth`，旧 authorize.ps1 仅转发；JavaScript 逻辑在 `.agents/skills/gidd/scripts/auth.mjs`，协议见 `.agents/skills/gidd/references/authorization.md`，仓库快捷命令为 `dev.cmd .auth`。授权由 gh 等待并保存凭据，随后验证 API 身份，不自动切换账号或启用仓库。`dev.cmd .test github` 在两种运行时执行同一套离线测试。
- 已用 Windows 便携 gh 2.98.0 验证：抑制浏览器启动、展示 URL 和一次性代码、用户自行授权后，登录成功且 API 返回预期账号；临时凭据已清理。Linux 无 GUI 流程尚未实测。
