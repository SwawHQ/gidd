# 仓库开发

产品 stage0 的已确认边界与验收范围见 [bootstrap 协议](.agents/skills/gidd/references/bootstrap.md)。当前仍在设计修订阶段；本文命令说明对应现有实现。产品迁移需同步审阅 dev.cmd 对共用脚本的调用，保留显式 managed/sys 模式和离线测试隔离。

`dev.cmd` 管理 GIDD 源码仓库自身的开发环境。已验证目标为 Windows x64 和 Windows PowerShell 5.1；它不代表在这个仓库启用了 GIDD。

技能发布入口为 `.agents/skills/gidd/gidd.cmd`，可先运行 `.\.agents\skills\gidd\gidd.cmd help zh`。产品用法见 [技能说明](.agents/skills/gidd/SKILL.md)；统一入口的开发验收使用 `.\dev.cmd .test entry`。帮助、诊断和工具准备使用系统 Shell，身份检查和授权由 Shell 启动共用 JavaScript。

`help`、`--help`、`-h` 等价。产品工具命令分别为 `setup bun`、`setup node`、`setup gh`。本项目的唯一技能源码位于 `.agents/skills/gidd/`，与仓库安装布局一致；入口从自身位置定位目标，支持 Git worktree，不依赖调用目录。可直接运行 `.\.agents\skills\gidd\gidd.cmd doctor` 或 `config show`。内部参数 `--repository <目标绝对路径>` 仅供开发和测试指定其他目标，普通调用无需追加，也不展示在 help 中。配置使用 `config show/set` 管理。完整技能安装和更新由 [Issue #14](https://github.com/SwawHQ/gidd/issues/14) 跟踪，工具版本与下载来源由配置管理，工具目录固定共享；配置增加可选的 github 表，执行身份检查或授权时相关字段必须齐备。

```powershell
.\dev.cmd .help zh
.\dev.cmd .help en
.\dev.cmd .info
.\dev.cmd .setup
.\dev.cmd .test
.\dev.cmd .test doctor
.\dev.cmd .test-bun
.\dev.cmd .test-node
```

无参数显示帮助。语言选择依次为 `.help` 参数、`GIDD_DEV_LANG`、`LC_ALL` / `LC_MESSAGES` / `LANG` / Windows UI 语言，其他系统语言回退英文。帮助和命令参数校验不需要 Bun/Node。入口以自身目录定位仓库，可以从其他工作目录用完整路径调用。

## 开发运行时

可以通过入口显式选择运行时执行命令或脚本，无需手写运行时路径：

```powershell
.\dev.cmd bun --version
.\dev.cmd node --version
.\dev.cmd bun scripts/example.mjs
.\dev.cmd node -e "console.log(process.version)"
.\dev.cmd sys bun scripts/example.mjs
.\dev.cmd sys node --version
```

`bun` / `node` 默认只使用固定共享目录中的对应便携版本；`sys bun` / `sys node` 则只搜索 PATH。两种模式互不回退，缺失、损坏或版本不匹配时明确报错，两者都遵守配置版本要求。入口只识别命令前缀，后续参数（包括 `--system`、`--help` 等）全部交给运行时或脚本。只检查选定运行时，入口不安装工具、不修改系统 PATH；运行中的用户命令可以自行联网或写文件。`.setup` / `.info` / `.test` 优先共享目录，再检查 PATH；复用 PATH 时不会额外创建便携副本。可用 `[sys] bun/node --version` 确认此次显式调用的版本。

脚本相对路径以调用者当前目录解析，stdin/stdout/stderr 透传，返回脚本退出码。运行时命令由 Shell 先定位可执行文件，随后批处理入口将参数直接交给 Node/Bun，避免 PowerShell 解释 runtime 的 `-`、`-e`、`--help` 或脚本参数；参数仍须遵守调用 Shell 的转义规则。例如 PowerShell 调用 `.cmd` 时要明确传递空参数，可用 `.\dev.cmd --% node script.mjs ""`。支持用 `dev.cmd node -` 从标准输入执行脚本；复杂内联代码也可保存为脚本文件。终端中可省略扩展名写 `dev bun ...`；PowerShell 在当前目录下仍需 `.\dev bun ...`。

`.setup bun`、`.setup node`、`.setup gh` 分别只准备指定工具；不指定工具的 `.setup` 保留同时准备 Bun 和 Node 的行为。分别优先复用共享目录中校验有效的工具，再检查 PATH（Bun 1.4.2、Node 24.19.0、gh 2.98.0）。固定版本还须精确匹配；缺失运行时由 PowerShell 按配置准备；.setup gh 先经过 stage0，再由 JavaScript 安装 gh。`.info` 分别报告两个运行时、配置要求和下载来源，仅当二者均可用时退出 0。

默认 Node 使用最新 LTS、Bun 使用最新稳定版，只在需要下载时解析；已有可用版本继续复用，诊断与测试不检查更新。`.agents/skills/gidd/assets/runtimes.json` 和 `scripts/dev/runtimes.json` 保留 Bun/gh 与开发 Node 的已验证版本校验信息。版本解析、官方校验信息、下载、SHA-256 校验、独占锁、版本验证及中断恢复共用技能脚本，不通过 Bun 安装 Node，也不通过 Node 安装 Bun。已有工具目录版本冲突时保留并报错，自动升级/回滚命令尚未实现。

Windows 上的 Bun 1.2.15 存在已复现的子进程兼容问题：启动不存在的程序后，后续 `spawnSync` 可能报告 `Out of memory`；脱离 GIDD 的最小示例也会触发。相同示例在 Bun 1.4.2 和 Node 上未复现，开发验收建议使用已验证的 Bun 1.4.2。`latest` 不会升级已有安装；升级前需确认实际使用的是 PATH 还是便携版本，便携版本应在安装器未运行时备份原 `bun/`，再执行 `.setup bun` 并确认选中的版本，最后运行完整 `.test`。

便携 Node 只提取 `node.exe` 和完整的上游 `LICENSE`，不附带 npm；当前测试没有 npm 依赖。开发入口可用 `.setup gh` 准备 gh；已安装 skill 的工具初始化仍只需 Bun/Node 任一种可用，不会因开发清单额外下载 Node。

安装只需 `.setup bun`、`.setup node` 或 `.setup gh`，不接受本地安装包目录。缺少工具时按配置联网下载并校验；已可用且满足配置的工具直接复用，不联网。实际安装位置固定为 `~/.agents/skills.tools/gidd/`。

## 配置与本地目录

配置模板为 `.agents/skills/gidd/assets/config.example.toml`；实例固定在 `<仓库>/.agents/skills/gidd/config.toml`，格式、默认值和校验范围见 [工具存储配置](.agents/skills/gidd/references/configuration.md)。开发入口、doctor、技能工具初始化共用 `.agents/skills/gidd/scripts/windows/lib/_configuration.ps1` 解析，Windows 启动不依赖 Bun/Node 或额外模块。

本仓库已实例化：

```toml
schema_version = 1
[tools]
node = { version = "lts", source = "https://nodejs.org/dist" }
bun = { version = "latest", source = "https://github.com/oven-sh/bun/releases" }
gh = { version = "latest", source = "https://github.com/cli/cli/releases" }
```

技能和开发入口共用 `~/.agents/skills.tools/gidd/`。Windows 按 USERPROFILE 定位用户家目录；不依赖仓库位置或当前目录。`.info` 的 storage 报告 config_path、tools_root 和各工具设置。配置不提供安装目录字段；没有配置时仍使用该共享目录及默认版本/来源，有错误配置时报错。

```text
<仓库>/.agents/skills/gidd/config.toml   # 仓库配置
~/.agents/skills.tools/gidd/            # 固定共享工具根
├── INSTALLATION.md
├── .cache/
│   └── install.lock
├── bun/
├── node/
└── gh/
```

复用外部工具不创建共享目录；按需下载后保留各工具许可证及 install.json。下载和解压暂存在 `.cache/<工具>/`，安装成功后清理对应暂存，保留缓存根和锁文件。安装时展示版本和完整 URL，使用官方 SHA-256 校验。

源码布局见 [Issue #16](https://github.com/SwawHQ/gidd/issues/16)。仓库 config.toml 单独维护，发布或复制技能时排除它及 config.toml.* 锁/临时文件，保留目标已有配置；新配置使用 assets/config.example.toml。共享工具位于仓库外，不随技能复制或提交。完整安装和更新尚未实现。

测试在每个 fixture 中设置临时 USERPROFILE，关闭 Bun 自身的编译缓存，结束后恢复环境；子进程按相同固定规则使用临时家目录下的工具根，不访问真实共享安装。测试 worker 内用例须串行。版本冲突测试验证既有安装保留，跨仓库测试验证同一用户共用目录。

共享工具可能被其他仓库使用；卸载当前仓库不得自动删除它。完整清理须明确包含共享目录并确认安装及使用进程已退出；外部 PATH 工具不属于 GIDD。自动升级/回滚尚未实现。

`dev.cmd` 仅在子进程范围隔离 PowerShell 模块路径，防止从 PowerShell 7 启动 PowerShell 5.1 时继承不兼容模块；不修改系统 PATH、Git 配置或用户级技能目录。显式 `.auth` 可以通过 gh 保存登录凭据。

## 显式 GitHub 授权

```powershell
.\dev.cmd .setup gh
.\dev.cmd .auth
```

先通过 `.\.agents\skills\gidd\gidd.cmd config set github.hostname <主机>` 和 `config set github.account <账号>` 写入仓库配置。`.auth` 不再接收账号参数，转发同一系统 Shell 分发器，仅使用配置中的主机和账号。需要 gh 2.98.0+ 和 Bun/Node 任一种；`.auth` 不下载工具，缺少 gh 时运行 `.setup gh`，缺少运行时时运行 `.setup bun` 或 `.setup node`。

`.setup gh` 先经过技能 stage0 自动复用或准备 Bun/Node，再由共用 JavaScript 优先复用共享目录、其次 PATH 中的 gh。缺失时按配置下载、校验并安装到固定共享工具根的 `gh/`。它遵守 `tools.gh` 的版本与来源，并要求至少 2.98.0；已有目录损坏或版本冲突时保留并报错，不自动升级覆盖。该命令输出技能安装 JSON，不发起登录，不修改系统 PATH。`.auth` 同样先经过 stage0，因此也可能准备缺失运行时。

入口先核验并复用匹配身份；否则在需要授权时显示本次 URL 和代码，等待用户在网页授权，最后验证实际账号。等待时保留进程，成功、失败、取消或超时后退出，不启动常驻服务。凭据由 gh 管理，可继承调用环境选定的 GH_CONFIG_DIR；不更改 Git 凭据助手或启用仓库。当前账号不匹配时明确报错，不自动切换。详见 [设备授权协议与凭据边界](.agents/skills/gidd/references/authorization.md)。

`.test github` 只执行离线 fixture，覆盖授权、复用、不匹配、超时、取消及入口调用；不会申请真实代码或修改真实登录。人工授权验证需单独运行 `.auth`，不能把普通测试通过当作真实授权完成。

## 测试

日常修改先用 `.test <测试组>` 验证受影响部分，提交前执行完整 `.test`。每组显示 PASS/FAIL 和耗时，结束后汇总失败文件及可复制的 PowerShell 复跑命令；双运行时执行结束后显示各运行时结果与总耗时。汇总按测试文件计数，不替代运行器输出的用例断言详情。一组失败不会阻止后续组或另一运行时执行。本地测试无需等待 GitHub CI。

默认 `.test` 先检查 Bun 和 Node 均可用，再依次使用二者执行同一套 `tests/*.test.mjs` 离线用例；任一运行失败，命令整体失败。支持测试组 `all`（默认）、`doctor`、`setup`、`process`、`dev`、`config`、`github`、`entry`。缺少任一运行时就明确报错，不安装、不联网，也不把未执行的运行时算作通过。`.test-bun` 和 `.test-node` 只检查并运行指定运行时，适合定位问题，不能替代双运行时验收。

测试使用 `node:test` 与 `node:assert/strict`，Bun 通过自身测试运行器执行，Node 使用 `--test`。用例、断言、临时目录、进程调度共用 JavaScript；`scripts/dev/dev.mjs` 适配启动参数，两种运行时均按文件串行启动独立进程，隔离测试状态，也避免 Bun 1.2.15 的 `node:test` 多文件注册缓存漏执行。`tests/support/javascript.mjs` 与 `windows.ps1` 对同一配置/安装 fixture 验证两份实现；Windows 辅助仅调用被测 PowerShell 函数、检查 BOM 后解析语法、编译 fixture executable 和构造 ZIP。C# fixture 用于模拟 Windows executable 和继承输出管道的进程，不属于产品。

`bun run test` 使用相同的双运行时入口；`bun run test:bun`、`bun run test:node` 分别选择一种。已有 npm 时也可以使用相应的 `npm run` 命令，但便携安装不提供 npm。

测试保留诊断只读、依赖缺失、PATH/受管工具选择、Node/Bun 复用、凭据脱敏、损坏目标保留、SHA/ZIP/版本拒绝、junction 拒绝、并发锁、强制终止恢复和共享超时期限等场景。`github` 组使用离线 fixture 验证 API 账号匹配、独立失败、凭据脱敏、进程超时和只读 Git 作者检查；不会触碰真实登录。产品身份检查用法见 [身份检查协议](.agents/skills/gidd/references/identity.md)，该入口需显式调用才会联网。其他空 JavaScript 文件仍是规划位置。

官方归档验证需要显式运行：

```powershell
.\dev.cmd .test-live
```

该命令分别在 Bun、Node 下验证官方 Bun/gh/Node 下载、完整性、版本、doctor 识别和已有工具复用。它解析最新稳定 Bun/gh 和 Node LTS，联网下载到隔离临时目录；不接受本地安装包目录。测试后清理隔离目录，不接触真实用户安装与登录。普通 `.test` 通过测试专用的模拟下载响应验证文件读取、哈希、解压和恢复，不联网；本地 fixture 输入只存在于 `tests/support/`。直接执行测试默认跳过联网测试；Bun 1.2.15 不应直接用 `bun test` 批量运行这些文件，请使用开发入口以确保每个文件都实际执行。

后续平台增加薄启动入口与平台适配，复用 JavaScript 用例；未提供 `dev.sh` / `dev.mac.sh`，不将 Windows 特有测试的跳过当作其他平台验证通过。产品 JavaScript 仍须仅使用两种运行时共有的标准 API，并在两者中验证同一功能。
