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

`.setup` 同时准备 Bun 和 Node，分别优先复用 PATH 中满足最低版本的运行时（Bun 1.2.15、Node 24.0.0），否则复用本 checkout 中校验有效的工具，缺失时使用 PowerShell 下载固定版本。`.info` 分别报告两个运行时，仅当二者均可用时退出 0。

Bun 固定清单沿用 `skills/gidd/assets/runtimes.json`；开发 Node 24.20.0 清单单独放在 `scripts/dev/runtimes.json`。Node Windows x64 ZIP 来自 [Node 官方发布目录](https://nodejs.org/dist/v24.20.0/)，SHA-256 对照该版本的 [SHASUMS256.txt](https://nodejs.org/dist/v24.20.0/SHASUMS256.txt) 固定。安装复用技能脚本的下载、SHA-256 校验、独占锁、版本验证及中断恢复函数，不通过 Bun 安装 Node，也不通过 Node 安装 Bun。

便携 Node 只提取 `node.exe` 和完整的上游 `LICENSE`，不附带 npm；当前测试没有 npm 依赖。开发入口不安装 gh，已安装 skill 的初始化仍只需 Bun/Node 任一种可用，不会因开发清单额外下载 Node。

可用 `.setup D:\downloads` 指定绝对离线归档目录，需为缺失工具提供 `bun-windows-x64.zip`、`bun-1.2.15-LICENSE.md`、`node-v24.20.0-win-x64.zip`。已可用的运行时不读取归档。

## 本地目录

`.dev/` 是本次 checkout 的可丢弃开发数据，已精确加入 `.gitignore`；不随技能发布，不保存启用配置。它与用户级 `gidd.tools/` 各自独立，采用相同的扁平结构：

```text
<仓库>/.dev/                   <用户技能根>/gidd.tools/
├── INSTALLATION.md             ├── INSTALLATION.md
├── .cache/                     ├── .cache/
│   └── install.lock            │   └── install.lock
├── bun/                       ├── bun/
└── node/                      └── gh/
```

目录按需建立；全部复用外部运行时时不建立 `.dev/`。下载和解压暂存在 `.dev/.cache/<工具>/download.part` 与 `payload/`，成功后删除对应工具子目录，保留缓存根和锁文件。中断后在下次显式重试时重建，不长期保留压缩包，也不支持断点续传。

安装期间不得删除缓存根或锁文件。确认安装和测试都已退出后可以删除 `.dev/` 重新准备；不能据此删除外部 PATH 中的工具或用户级技能工具。旧版 `.dev/tools/` 不再作为开发工具查找位置；所有安装和测试退出后，可将其中完整的 `bun/` 移至尚不存在的 `.dev/bun/`，再运行 `.setup` 校验并补齐 Node，或重新准备开发环境。确认无需保留后再清理旧目录，不要同时运行新旧入口。

`dev.cmd` 仅在子进程范围隔离 PowerShell 模块路径，防止从 PowerShell 7 启动 PowerShell 5.1 时继承不兼容模块；不修改系统 PATH、Git 配置、登录或用户级技能目录。

## 测试

默认 `.test` 先检查 Bun 和 Node 均可用，再依次使用二者执行同一套 `tests/*.test.mjs` 离线用例；任一运行失败，命令整体失败。支持测试组 `all`（默认）、`doctor`、`setup`、`process`、`dev`。缺少任一运行时就明确报错，不安装、不联网，也不把未执行的运行时算作通过。`.test-bun` 和 `.test-node` 只检查并运行指定运行时，适合定位问题，不能替代双运行时验收。

测试使用 `node:test` 与 `node:assert/strict`，Bun 通过自身测试运行器执行，Node 使用 `--test`。用例、断言、临时目录、进程调度共用 JavaScript；`scripts/dev/dev.mjs` 适配启动参数，两种运行时均按文件串行启动独立进程，隔离测试状态，也避免 Bun 1.2.15 的 `node:test` 多文件注册缓存漏执行。`tests/support/windows.ps1` 仅调用被测 PowerShell 函数、检查 BOM 后解析语法、编译 fixture executable 和构造 ZIP。C# fixture 用于模拟 Windows executable 和继承输出管道的进程，不属于产品。

`bun run test` 使用相同的双运行时入口；`bun run test:bun`、`bun run test:node` 分别选择一种。已有 npm 时也可以使用相应的 `npm run` 命令，但便携安装不提供 npm。

测试保留诊断只读、依赖缺失、PATH/受管工具选择、Node/Bun 复用、凭据脱敏、损坏目标保留、SHA/ZIP/版本拒绝、junction 拒绝、并发锁、强制终止恢复和共享超时期限等场景。当前产品 JavaScript 仍是规划位置，双运行时测试验证现有开发代码和 PowerShell 接口，不能据此声称尚未实现的产品功能已支持 Node/Bun。

官方归档验证需要显式运行：

```powershell
.\dev.cmd .test-live
.\dev.cmd .test-live D:\downloads
```

该命令分别在 Bun、Node 下验证官方 Bun/gh/Node 下载、完整性、版本、doctor 识别和离线复用。无目录参数时联网下载到隔离临时目录；有目录参数时读取预下载官方文件并校验固定 SHA-256，除上述开发归档外还需 `gh_2.98.0_windows_amd64.zip`。测试后清理隔离目录，不接触真实用户安装与登录。直接执行测试默认跳过联网测试；Bun 1.2.15 不应直接用 `bun test` 批量运行这些文件，请使用开发入口以确保每个文件都实际执行。

后续平台增加薄启动入口与平台适配，复用 JavaScript 用例；未提供 `dev.sh` / `dev.mac.sh`，不将 Windows 特有测试的跳过当作其他平台验证通过。产品 JavaScript 仍须仅使用两种运行时共有的标准 API，并在两者中验证同一功能。
