# 仓库开发

`dev.cmd` 管理 GIDD 源码仓库自身的开发环境。已验证目标为 Windows x64 和 Windows PowerShell 5.1；它不代表在这个仓库启用了 GIDD。

```powershell
.\dev.cmd .help zh
.\dev.cmd .help en
.\dev.cmd .info
.\dev.cmd .setup
.\dev.cmd .test
.\dev.cmd .test doctor
```

无参数显示帮助。语言选择依次为 `.help` 参数、`GIDD_DEV_LANG`、`LC_ALL` / `LC_MESSAGES` / `LANG` / Windows UI 语言，其他系统语言回退英文。帮助和命令参数校验不需要 Bun。入口以自身目录定位仓库，可以从其他工作目录用完整路径调用。

`.setup` 优先复用 PATH 中的 Bun（至少 1.2.15），否则使用 PowerShell 安装 `skills/gidd/assets/runtimes.json` 固定的 Bun 版本。下载、哈希、锁及中断恢复复用已有内部函数，不安装 gh。可传绝对离线归档目录，需包含 `bun-windows-x64.zip` 和 `bun-1.2.15-LICENSE.md`。现有 Node 不替代开发测试所需的 Bun；产品运行时选择仍保持 Node/Bun 任一种可用即可。

`.dev/` 是本次 checkout 的可丢弃开发数据，已精确加入 `.gitignore`。它不属于用户级 `gidd.tools/`，不保存仓库启用配置，也不随技能发布。开发 Bun 存在 `.dev/tools/bun/`，来源和清理说明存在 `.dev/INSTALLATION.md`。确认安装和测试均已退出后可以删除 `.dev/` 重新准备；不能据此删除外部 PATH 中的 Bun 或用户级技能工具。

`dev.cmd` 仅在子进程范围隔离 PowerShell 模块路径，防止从 PowerShell 7 启动 PowerShell 5.1 时继承不兼容模块；不修改系统 PATH、Git 配置、登录或用户级技能目录。

## 测试

默认 `.test` 使用 Bun 内置测试运行器执行 `tests/*.test.mjs` 中的离线测试，可指定 `doctor`、`setup`、`process` 或 `dev`。它不会安装 Bun，也不会联网。`bun run test` 使用相同入口。

用例、断言、临时目录、进程调度使用 JavaScript。`tests/support/helpers.mjs` 提供通用测试辅助；`tests/support/windows.ps1` 仅调用被测 PowerShell 函数、解析脚本、编译 fixture executable 和构造 ZIP。C# fixture 仅用于模拟 Windows executable 和继承输出管道的进程，不属于产品。

测试保留缺失依赖、PATH/受管工具选择、Node/Bun 复用、只读诊断、配置和仓库状态、凭据脱敏、损坏目标保留、SHA/ZIP/版本拒绝、junction 拒绝、并发锁及强制终止后恢复、共享超时期限等场景。PowerShell 源文件先检查 UTF-8 BOM，再解析语法。

官方归档验证需要单独显式运行：

```powershell
.\dev.cmd .test-live
.\dev.cmd .test-live D:\downloads
```

无目录参数时联网下载 Bun/gh 到隔离临时目录；有目录参数时读取预下载官方文件并校验固定 SHA-256。测试后清理隔离目录，不接触真实用户安装与登录。所需文件名见 `skills/gidd/references/setup.md`。直接运行 `bun test` 默认跳过联网测试。

后续平台增加薄启动入口与平台适配，复用 JavaScript 测试用例；未提供 `dev.sh` / `dev.mac.sh`，不将 Windows 特有测试的跳过当作其他平台验证通过。只有出现 macOS 独有启动需求才拆出单独 macOS 入口。

开发测试依赖 `bun:test`，不改变 `skills/gidd/scripts/` 产品 JavaScript 仅使用 Node.js/Bun 共同支持 API 的约束。产品 JavaScript 实现后仍须对同一功能分别用 Node.js 和 Bun 验证，不能用 Bun 测试运行器通过代替 Node.js 验证。
