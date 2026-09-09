# stage0 与 JavaScript 的边界

状态：Windows x64 / PowerShell 5.1 的 stage0 与共用 JavaScript 已实现；Linux/macOS 启动器仍待实现与验证。

设计由 [Issue #19](https://github.com/SwawHQ/gidd/issues/19) 确认，实现与迁移由 [Issue #21](https://github.com/SwawHQ/gidd/issues/21) 跟踪。

## 固定位置与配置

GIDD 下载的工具永久使用当前用户家目录下的 `~/.agents/skills.tools/gidd/`，Bun、Node、gh 分别使用 `bun/`、`node/`、`gh/`。这不是可覆盖的默认值，不提供配置、命令行或专用环境变量来定制安装位置。系统家目录的正常解析及测试隔离不属于工具目录配置。

目标配置固定为 `<目标仓库>/.agents/skills/gidd/config.toml`。支持可选字段：

```toml
[bootstrap]
# 同一来源内优先选择此运行时；两处均无合格候选时安装它。
# 允许 bun 或 node。共享目录始终优先于 PATH。
runtime = "bun"
```

省略 bootstrap 表或 runtime 字段时使用 bun，保持旧配置可读；显式空值或其他值报错，不静默改为默认值。模板和新建配置写明默认值。现有 tools.node/tools.bun 内联表继续配置 version/source；source 是下载来源，不是安装位置。

最低支持版本随技能发布并由技能维护，Shell 与 JavaScript 读取同一份运行时要求；仓库不增加 min_version 或 bin 字段。最低版本保存在 assets/runtime-requirements.json：Bun 1.4.2、Node 24.19.0；此前已用这两个版本完成基线双运行时验收。后续补丁版本仍须通过项目测试，不以版本号代替验证。

## 启动顺序

1. 读取技能最低版本要求、目标仓库的 Bun/Node 配置和 bootstrap.runtime。
2. 检查固定共享目录：先默认运行时，再另一种；受管安装必须先验证完整性再执行版本探测。
3. 有合格候选立即启动 JavaScript，不再为了运行时选择检查 PATH。
4. 否则检查 PATH：先默认运行时，再另一种；每种运行时按 PATH 候选顺序探测。
5. 有合格候选立即启动 JavaScript，不为了默认偏好额外下载工具。
6. 两处均无合格候选时，自动下载、校验并安装默认运行时，验证后启动 JavaScript。失败则报告本次失败，不自动改装另一种运行时。

合格候选必须可执行、达到技能最低版本，并满足该工具配置的固定版本要求。latest/lts 沿用当前含义：已有合格工具直接复用，只在缺失需要下载时解析版本，不在启动时自动升级或联网证明既有 Node 属于 LTS。配置非法时报告错误，不忽略非法版本或下载来源来安装。help 与 config 编辑是既有版本约束的例外：只要求候选达到技能最低版本，便于修改尚未安装的新 pin；来源顺序和完整性要求不变。无候选时仍按配置准备默认运行时。

来源优先于偏好。例如默认 bun 时，共享目录中的合格 Node 优先于 PATH 中的 Bun；共享目录没有合格候选且 PATH 只有合格 Node 时，直接用 Node；两者都缺失才下载 Bun。用户改为 node 时交换每一来源内的检查顺序，仍保持共享目录优先。

受管目录损坏或版本冲突时不执行该候选，保留文件并记录拒绝原因，可以继续寻找其他合格候选。同一个受管 executable 即使通过 PATH 找到也不能绕过完整性校验。需要下载的正式目录已被占用时报告冲突，不覆盖、不删除、不静默换位置。

## 两层职责

Shell 负责启动所需的配置读取、运行时探测、首次运行时下载及其校验、受控解压、锁、发布与中断恢复，并启动 JavaScript。安装器须在锁内重新检查状态，避免多个仓库同时首次启动时重复发布。只有进入安装准备时才创建共享工具目录，复用 PATH 工具不创建空目录。

JavaScript 负责完整配置校验与编辑、完整 doctor、gh 准备、GitHub 身份检查和设备授权，后续 Issue/PR 业务也归 JavaScript。setup gh 也先经过运行时 bootstrap；stage0 不安装 gh、不启动登录、不启用仓库。

Shell 用已选定的 executable 直接启动 JS，透传参数、标准输入输出和退出码。JS 通过 process.execPath 获取当前运行时；来源等本次启动元数据需要时用内部参数或子进程环境传递，不写入仓库配置，也不创建 bootstrap.txt/stage0.txt。每次启动重新探测。

## 安装与诊断流程

运行时检查 → 必要时自动下载并准备运行时 → 启动 JS → doctor → 按请求补齐其他工具或配置。

所有公开命令（包括 help）先经过 stage0。完整 doctor 不再承担无运行时诊断。JS doctor 本身只读、不联网安装；通过系统入口首次调用 doctor 时，前置 stage0 可以联网和写入共享运行时目录，帮助文案必须说明这一点。stage0 失败返回 gidd.cli/v1、退出 2，并通过 reason 报告配置、下载、校验或锁错误，不能输出仿造的 doctor 成功或把未执行检查视为通过。

运行时准备不修改 config.toml、不修改系统 PATH、不授权 GitHub、不代表仓库启用。缺少配置时采用已公开的启动默认值即可，配置创建和编辑仍归 JS；不得用自动 bootstrap 推断缺失 GitHub 身份字段。

## 迁移验收

- 默认 Bun，以及显式默认 Node 的每种来源内顺序；共享 Node 优先 PATH Bun，反向偏好也遵守来源优先级。
- 合格候选立即启动，后续候选不探测，不下载、不改配置；最低版本和固定版本不符的候选拒绝。
- 完整性失败的受管候选不执行；经 PATH 再次发现同一路径也不能绕过检查。
- 无运行时自动安装默认运行时；下载失败、哈希失败、占用冲突、并发启动和中断重试保留现有边界。
- JS 接收到原始参数、标准输入输出和退出码；不生成 bin 配置或启动路径文件。
- JS doctor、配置及 GitHub 逻辑在 Node/Bun 两种运行时验证；首次启动下载用隔离 fixture 验证，普通离线测试不访问真实网络、工具目录或登录状态。
- 更新 SKILL.md、配置模板与本仓库实例、help 及各 references；当前实现与目标设计状态始终明确。Linux/macOS 未实测前不得宣称支持。
