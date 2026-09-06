# 仓库开发

`dev.cmd` 管理 GIDD 源码仓库自身的开发环境。已验证目标为 Windows x64 和 Windows PowerShell 5.1；它不代表在这个仓库启用了 GIDD。

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

可以通过入口显式选择运行时执行命令或脚本，无需手写 `.devv/` 路径：

```powershell
.\dev.cmd bun --version
.\dev.cmd node --version
.\dev.cmd bun scripts/example.mjs
.\dev.cmd node -e "console.log(process.version)"
.\dev.cmd sys bun scripts/example.mjs
.\dev.cmd sys node --version
```

`bun` / `node` 默认只使用配置工具目录中的对应便携版本；`sys bun` / `sys node` 则只搜索 PATH。两种模式互不回退，缺失、损坏或版本不匹配时明确报错，两者都遵守配置版本要求。入口只识别命令前缀，后续参数（包括 `--system`、`--help` 等）全部交给运行时或脚本。只检查选定运行时，入口不安装工具、不修改系统 PATH；运行中的用户命令可以自行联网或写文件。当前 `.setup` / `.info` / `.test` 保留原有 PATH 优先策略，`.setup` 复用 PATH 时不会额外创建便携副本。可用 `[sys] bun/node --version` 确认此次显式调用的版本。

脚本相对路径以调用者当前目录解析，stdin/stdout/stderr 透传，返回脚本退出码。启动器收到的参数通过数据编码转发，避免 PowerShell 再次解释 runtime 的 `-e`、`--help` 或脚本参数；参数仍须遵守调用 Shell 的转义规则。例如 PowerShell 调用 `.cmd` 时要明确传递空参数，可用 `.\dev.cmd --% node script.mjs ""`。复杂内联代码建议保存为脚本文件。终端中可省略扩展名写 `dev bun ...`；PowerShell 在当前目录下仍需 `.\dev bun ...`。

`.setup` 同时准备 Bun 和 Node，分别优先复用 PATH 中满足最低版本的运行时（Bun 1.2.15、Node 24.0.0），否则复用配置目录中校验有效的工具。固定版本还须精确匹配；缺失时使用 PowerShell 按配置解析版本、校验并下载。`.info` 分别报告两个运行时、配置要求和下载来源，仅当二者均可用时退出 0。

默认 Node 使用最新 LTS、Bun 使用最新稳定版，只在需要下载时解析；已有可用版本继续复用，诊断与测试不检查更新。`skills/gidd/assets/runtimes.json` 和 `scripts/dev/runtimes.json` 保留 Bun/gh 与开发 Node 的固定离线基线。版本解析、官方校验信息、下载、SHA-256 校验、独占锁、版本验证及中断恢复共用技能脚本，不通过 Bun 安装 Node，也不通过 Node 安装 Bun。已有工具目录版本冲突时保留并报错，自动升级/回滚命令尚未实现。

便携 Node 只提取 `node.exe` 和完整的上游 `LICENSE`，不附带 npm；当前测试没有 npm 依赖。开发入口不安装 gh，已安装 skill 的初始化仍只需 Bun/Node 任一种可用，不会因开发清单额外下载 Node。

可用 `.setup D:\downloads` 指定绝对离线归档目录；首次离线安装须在配置中固定内置基线 Bun 1.2.15、Node 24.20.0，并提供 `bun-windows-x64.zip`、`bun-1.2.15-LICENSE.md`、`node-v24.20.0-win-x64.zip`。其他版本或 lts/latest 缺少离线元数据时明确报错。已可用且满足配置的运行时不读取归档、不联网。

## 配置与本地目录

配置模板为 `skills/gidd/assets/config.example.toml`；实例固定在 `<仓库>/.agents/skills/gidd/config.toml`，格式、默认值和校验范围见 [工具存储配置](skills/gidd/references/configuration.md)。开发入口、doctor、技能工具初始化共用 `skills/gidd/scripts/windows/lib/_configuration.ps1` 解析，Windows 启动不依赖 Bun/Node 或额外模块。

本仓库已实例化：

```toml
schema_version = 1
[tools]
directory = ".devv"
node = { version = "lts", source = "https://nodejs.org/dist" }
bun = { version = "latest", source = "https://github.com/oven-sh/bun/releases" }
gh = { version = "latest", source = "https://github.com/cli/cli/releases" }
```

因此本仓库工具根是 `.devv/`，`.info` 的 `storage` 会报告配置路径、原始 directory 和实际位置。没有配置时开发入口默认 `.dev/`，技能入口默认 `~/.agents/skills/gidd.tools/`；有配置时不做多层继承，错误配置也不回退。`tools.directory` 支持仓库相对路径、以 `~/` 开头的家目录路径和 Windows 本地盘绝对路径。技能安装位置由 Agent 处理，工具入口不需要用户技能根或安装模式参数。

```text
<仓库>/.agents/skills/gidd/config.toml   # 实例，可编辑并审阅
<仓库>/.devv/                         # 当前实例指定的工具根
├── INSTALLATION.md
├── .cache/
│   └── install.lock
├── bun/
├── node/
└── gh/                               # 仅技能入口按需准备
```

目录按需建立，复用外部工具不会仅因配置存在而建立下载目录。配置显式展示版本策略和下载根；镜像须保留上游布局，版本及校验信息仍从官方来源取得。安装时展示确切版本与完整下载 URL，install.json 保存实际来源和校验值。下载、解压暂存在 `<工具根>/.cache/<工具>/download.part` 与 `payload/`，成功后删除对应工具子目录，保留缓存根与锁文件。中断后显式重试重建暂存，不长期保留压缩包或提供断点续传。

本仓库精确忽略 `/.dev/` 与 `/.devv/`，没有忽略整个 `.agents/`；当前实例只含可移植的相对目录，不保存凭据，也不表示启用 GIDD。更改 directory 时，应同时为新的下载目录设置精确忽略规则，配置读取器不会修改 Git 忽略规则。

切换配置不会自动搬迁或删除旧工具。确认所有安装与测试退出、目标尚不存在后可显式迁移原目录，再用 `.setup` 验证完整性与复用。安装期间不得删除缓存根或锁文件。只清理明确拥有的工具目录；用户级存储可能由其他仓库共用，外部 PATH 工具不属于本项目。更多清理边界见配置文档。

`dev.cmd` 仅在子进程范围隔离 PowerShell 模块路径，防止从 PowerShell 7 启动 PowerShell 5.1 时继承不兼容模块；不修改系统 PATH、Git 配置或用户级技能目录。显式 `.auth` 可以通过 gh 保存登录凭据。

## 显式 GitHub 授权

```powershell
.\dev.cmd .auth octocat
```

账号必填，开发快捷入口使用 github.com；其他主机使用技能的 `scripts/windows/authorize.ps1 -Hostname`。需要现成的 gh 2.98.0+ 和 Bun/Node 任一种；`.auth` 不下载工具，`.setup` 仍只准备开发运行时，缺少 gh 时通过技能 `setup-tools.ps1 -RepositoryPath <仓库绝对路径>` 显式准备。

入口先核验并复用匹配身份；否则在需要授权时显示本次 URL 和代码，等待用户在网页授权，最后验证实际账号。等待时保留进程，成功、失败、取消或超时后退出，不启动常驻服务。凭据由 gh 管理，可继承调用环境选定的 GH_CONFIG_DIR；不更改 Git 凭据助手或启用仓库。当前账号不匹配时明确报错，不自动切换。详见 [设备授权协议与凭据边界](skills/gidd/references/authorization.md)。

`.test github` 只执行离线 fixture，覆盖授权、复用、不匹配、超时、取消及入口调用；不会申请真实代码或修改真实登录。人工授权验证需单独运行 `.auth`，不能把普通测试通过当作真实授权完成。

## 测试

日常修改先用 `.test <测试组>` 验证受影响部分，提交前执行完整 `.test`。每组显示 PASS/FAIL 和耗时，结束后汇总失败文件及可复制的 PowerShell 复跑命令；双运行时执行结束后显示各运行时结果与总耗时。汇总按测试文件计数，不替代运行器输出的用例断言详情。一组失败不会阻止后续组或另一运行时执行。本地测试无需等待 GitHub CI。

默认 `.test` 先检查 Bun 和 Node 均可用，再依次使用二者执行同一套 `tests/*.test.mjs` 离线用例；任一运行失败，命令整体失败。支持测试组 `all`（默认）、`doctor`、`setup`、`process`、`dev`、`config`、`github`。缺少任一运行时就明确报错，不安装、不联网，也不把未执行的运行时算作通过。`.test-bun` 和 `.test-node` 只检查并运行指定运行时，适合定位问题，不能替代双运行时验收。

测试使用 `node:test` 与 `node:assert/strict`，Bun 通过自身测试运行器执行，Node 使用 `--test`。用例、断言、临时目录、进程调度共用 JavaScript；`scripts/dev/dev.mjs` 适配启动参数，两种运行时均按文件串行启动独立进程，隔离测试状态，也避免 Bun 1.2.15 的 `node:test` 多文件注册缓存漏执行。`tests/support/windows.ps1` 仅调用被测 PowerShell 函数、检查 BOM 后解析语法、编译 fixture executable 和构造 ZIP。C# fixture 用于模拟 Windows executable 和继承输出管道的进程，不属于产品。

`bun run test` 使用相同的双运行时入口；`bun run test:bun`、`bun run test:node` 分别选择一种。已有 npm 时也可以使用相应的 `npm run` 命令，但便携安装不提供 npm。

测试保留诊断只读、依赖缺失、PATH/受管工具选择、Node/Bun 复用、凭据脱敏、损坏目标保留、SHA/ZIP/版本拒绝、junction 拒绝、并发锁、强制终止恢复和共享超时期限等场景。`github` 组使用离线 fixture 验证 API 账号匹配、独立失败、凭据脱敏、进程超时和只读 Git 作者检查；不会触碰真实登录。产品身份检查用法见 [身份检查协议](skills/gidd/references/identity.md)，该入口需显式调用才会联网。其他空 JavaScript 文件仍是规划位置。

官方归档验证需要显式运行：

```powershell
.\dev.cmd .test-live
.\dev.cmd .test-live D:\downloads
```

该命令分别在 Bun、Node 下验证官方 Bun/gh/Node 下载、完整性、版本、doctor 识别和离线复用。无目录参数时解析最新稳定 Bun/gh 和 Node LTS，联网下载到隔离临时目录；有目录参数时固定内置基线、读取预下载官方文件并校验固定 SHA-256，除上述开发归档外还需 `gh_2.98.0_windows_amd64.zip`。测试后清理隔离目录，不接触真实用户安装与登录。直接执行测试默认跳过联网测试；Bun 1.2.15 不应直接用 `bun test` 批量运行这些文件，请使用开发入口以确保每个文件都实际执行。

后续平台增加薄启动入口与平台适配，复用 JavaScript 用例；未提供 `dev.sh` / `dev.mac.sh`，不将 Windows 特有测试的跳过当作其他平台验证通过。产品 JavaScript 仍须仅使用两种运行时共有的标准 API，并在两者中验证同一功能。
