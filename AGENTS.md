# GIDD 开发规则

## Scope

本文件适用于 `SwawHQ/gidd` 仓库。以下为已确认的开发约束，不表示功能已经实现。

- **目标仓库**：用户要求启用 GIDD 并进行开发的 Git 仓库。
- **技能安装目录**：实际包含 GIDD `SKILL.md` 和配套脚本的目录，可以位于用户技能目录或目标仓库的 `.agents/skills/gidd/`。
- **仓库配置文件**：固定为 `<目标仓库>/.agents/skills/gidd/config.toml`，与技能安装范围无关。
- **用户技能根目录**：由 Agent 客户端自行决定；技能安装位置及用户级/仓库级模式不写入 GIDD 配置，也不参与下载工具路径解析。
- **工具目录**：推荐 `~/.agents/skills/gidd.tools/`，其中 `~` 指当前操作系统用户家目录。`tools.directory` 直接指定家目录路径、仓库相对路径或本地盘绝对路径，独立于技能安装位置；规则见 `skills/gidd/references/configuration.md`。
- 本项目的 `skills/gidd/` 是技能发布源码目录，不等于用户安装位置，也不因存在该目录而启用本项目自身的 GIDD 流程。

## Accepted

1. **GIDD-001 — 产品与交付边界。** `skills/gidd/SKILL.md` 组织 GitHub Issue、关联分支、Draft PR、本地验证、review 和人工 merge；Issue 与 PR 保存工作目标和交付证据，不另建任务状态数据库。公开技能和脚本不得依赖 `ghswaw.cmd`、`swaw-kit` 安装目录或开发者机器的绝对路径。

2. **GIDD-002 — 对话管理与显式启用。** GIDD 的安装、初始化和管理以用户与 Agent 的对话为入口；例如“当前仓库启用 GIDD”“检查此仓库的 GitHub 登录”。安装到用户目录只提供技能，不启用任何仓库。用户明确要求启用某个目标仓库后，Agent 才执行该仓库的初始化；再次初始化应复用有效配置并补齐缺项，不重复登录或重建开发任务。底层脚本提供可验证的操作与结果，首版不另做面向人类的交互式配置向导。

3. **GIDD-003 — 配置唯一且具体归属。** 运行配置 `config.toml` 只保存在 `<目标仓库>/.agents/skills/gidd/`；用户级技能安装目录，若出现 GIDD `config.toml` 属于未定义行为，如何使用看用户如何提示；`config.toml` 不会自动继承或多层覆盖。用户级技能服务的目标仓库也使用上述固定路径；该目录只有配置文件时，不代表已安装完整技能。`config.toml` 使用注释解释字段，允许人类直接编辑，Agent 修改时保留无关字段和注释。工具配置 schema v1 已确定为 `schema_version`、`tools.directory` 与 node/bun/gh 内联表（version、source），模板见 `skills/gidd/assets/config.example.toml`。启用记录仍未定义，不能凭配置存在执行治理流程。

4. **GIDD-004 — 认证由授权事实确认。** `config.toml` 可以记录预期 GitHub 主机与账号，不保存 token、密码或二次验证码；修改账号字段不能视作已登录。有人参与的 gh 登录统一展示本次认证返回的 URL 和一次性用户代码，不自动打开浏览器，由用户在任意设备完成授权；脚本等待并验证实际身份后才报告成功。GitHub API 认证、Git 传输认证和 commit 作者信息分别检查。无 GUI 环境也采用该流程；长期凭据的保存位置由选定认证方式决定，不承诺复制配置即可复制登录状态。

5. **GIDD-005 — 实现与规则保持精简。** `skills/gidd/scripts/` 业务代码使用 JavaScript，Node.js 与 Bun 均为支持目标，只使用双方支持的标准 API，同一功能须在两种运行时验证；系统 Shell 可承担无 Bun/Node 前提的环境诊断、工具存储配置读取与必要启动操作，GitHub 开发流程业务逻辑仍使用 JavaScript；不预先宣称未经测试的运行时或平台兼容性。规则应指明文件、目录、命令或其他具体实体；涉及交互原则时给出使用例子。源码、发布物和本地下载数据必须区分，README 由维护者维护。当前实现范围为 Windows 基础 doctor、工具初始化、工具存储配置、只读身份检查及显式设备授权，仓库开发入口由 Issue #8 和 #10 跟踪；不得把尚未实现的初始化或治理能力表述为可用。PowerShell 源文件使用带 BOM 的 UTF-8，验证须先检查 BOM 再进行语法解析。

6. **GIDD-006 — 工具集中存储与清理。** 已有可用的 Bun、gh 优先复用；需要 GIDD 下载工具时才建立实际工具目录；默认工具目录为 `~/.agents/skills/gidd.tools/`，用户通过 `tools.directory` 直接指定位置。Bun、Node、gh 分别保存在工具根的 `bun/`、`node/`、`gh/` 下，Node 下载目前由仓库开发入口提供。该目录只管理 GIDD 下载的工具及配套安装数据，不保存 GIDD `config.toml`；目录及全部子目录不得包含 `SKILL.md`。其中 `INSTALLATION.md` 说明用途、工具来源和清理方式，供人类及 Agent 主动读取。建立共享工具目录不代表安装用户级技能或启用任何仓库。收到卸载请求时，GIDD 管理流程检查 Agent 确认的技能实际安装目录、仓库配置文件、默认及配置指定的工具目录，展示清理范围；仅卸载当前仓库不得自动删除共享工具，无法确认其他仓库是否使用时不得声称工具已无引用。完整卸载须明确包含共享工具；不得删除复用的外部工具，也不得将删除文件表述为退出 GitHub 或撤销授权。

## Open

- **GIDD-007 — Git 与更新边界。** 需确定仓库内技能源码、`config.toml` 和本地数据各自的提交策略，以及技能更新如何保留配置和下载数据。不要把整个 `.agents/` 默认视为应提交或应忽略。首次空基线已建立；后续修订通过 Issue 关联分支和 PR 审阅。
- **GIDD-008 — 后续初始化边界。** Windows 基础诊断入口已确定为 `skills/gidd/scripts/windows/doctor.ps1`，使用系统 PowerShell 且不依赖 Bun/Node；协议与检查范围见 `skills/gidd/references/doctor.md`。其他平台另选并验证系统 Shell；仅检查平台、Git、Bun/Node、gh、目标仓库及配置是否可用，依赖缺失时继续报告其他可检查项。诊断不安装工具、不启动登录、不修改配置；Agent 根据诊断引导用户，下载、校验、解压属于独立初始化操作。工具安装与恢复协议见 skills/gidd/references/setup.md；完整配置及 GitHub 身份检查与 JavaScript 的职责划分、网络认证范围及凭据存储位置仍待确定。不得让安装 Bun 的 JavaScript 以“Bun 已安装”为唯一启动前提，也不得把依赖缺失导致的未检查报告为检查通过。

## Maintainer Notes

- `dev.cmd .setup bun`、`.setup node`、`.setup gh` 分别准备指定工具，共用技能安装代码及仓库工具配置；`.setup gh` 不要求 Bun/Node，也不发起登录。安装只支持按配置联网下载或复用已有工具，不接受本地安装包目录；实际安装位置始终由工具配置决定。

- 开发前先看 `dev.cmd .help zh` 和 `DEVELOPMENT.md`。运行命令/脚本使用 `dev.cmd bun ...` 或 `dev.cmd node ...`，默认只用配置目录中的便携版本；显式 `dev.cmd sys bun ...` / `dev.cmd sys node ...` 只搜索 PATH，两种模式互不回退。不手写 `.devv/` 或开发者机器的运行时路径。日常验证用 `dev.cmd .test <测试组>`；提交前用完整 `.test` 做 Node/Bun 双运行时验收。`.auth <账号>` 是会保存 gh 凭据的真实授权快捷入口，不是离线测试；普通测试不得触发它。统一技能公开 JavaScript 入口由 Issue #12 跟踪，本批不混入入口重构。

- 仓库开发入口为根 `dev.cmd`，用法见 `DEVELOPMENT.md`。`scripts/dev/` 和 `tests/` 属于仓库开发工具；`.setup` 准备 Bun 和 Node，`.test` 分别在两种运行时执行同一套 JavaScript 用例，Windows 辅助仅保留被测 PowerShell 接口与 fixture 构造。开发 Node 已验证版本清单位于 `scripts/dev/runtimes.json`，仅提取运行时和许可证，不附带 npm。工具目录由固定位置的仓库配置解析；无配置时开发默认 `.dev/`，本仓库实例选择 `.devv/`，二者均精确忽略且不随技能发布。工具位置读取 `tools.directory`，下载版本与来源读取工具内联表，不需要 Agent 技能安装模式或用户技能根参数；产品脚本的 Node/Bun 双运行时约束不变，技能工具初始化仍只要求其中一种运行时可用。

- 当前实现 Windows x64 / Windows PowerShell 5.1 基础 doctor 与便携 Bun/gh 工具初始化，包含完整性校验、独占锁和中断后重试；工具配置读取、缺失工具的稳定版本解析与官方 SHA-256 校验已实现；浮动版本不自动升级已有工具，固定版本冲突时保留并报错。自动升级/回滚、自动配置写入、启用记录及 Issue/PR 业务脚本尚未实现。根 package.json 用于仓库开发测试；其余空 JavaScript 产品脚本仅表达规划位置，不是业务实现。
- GIDD 自有代码和技能文档采用根 LICENSE 的 MIT 许可证；第三方下载工具保留各自许可证。结构整理由 Issue #1 跟踪，Windows doctor 由 Issue #2 跟踪。
- 本地测试结果、耗时与复跑提示由 Issue #10 跟踪；只读 GitHub 身份检查由 Issue #11 跟踪，入口为 `skills/gidd/scripts/windows/check-identity.ps1`，业务逻辑在 `skills/gidd/scripts/github.mjs`，协议见 `skills/gidd/references/identity.md`。预期主机/账号由调用参数传入；API 身份、Git 远程读取和 commit 作者分开报告，读取成功不代表 Git 推送认证通过；显式设备授权入口为 `skills/gidd/scripts/windows/authorize.ps1`，JavaScript 逻辑在 `skills/gidd/scripts/auth.mjs`，协议见 `skills/gidd/references/authorization.md`，仓库快捷命令为 `dev.cmd .auth <账号>`。授权由 gh 等待并保存凭据，随后验证 API 身份，不自动切换账号或启用仓库。`dev.cmd .test github` 在两种运行时执行同一套离线测试。
- 已用 Windows 便携 gh 2.98.0 验证：抑制浏览器启动、展示 URL 和一次性代码、用户自行授权后，登录成功且 API 返回预期账号；临时凭据已清理。Linux 无 GUI 流程尚未实测。
