# 工具准备与共享绑定

Windows x64 / Windows PowerShell 5.1。统一入口由 Issue #39 跟踪；此前运行时启动器由 #23 跟踪。Linux/macOS 启动器尚未实现或验证。

| 命令 | 行为 |
| --- | --- |
| `gidd.cmd bootstrap` | 检查并补齐一个 JS 运行时、Git、gh，发布启动器与工具绑定 |
| `gidd.cmd bootstrap --check` | 只读检查运行时、工具、绑定和待恢复安装；不下载、不写入 |
| `gidd.cmd bootstrap --node` | 选择/准备 Node，并完成同样的 Git/gh 准备 |
| `gidd.cmd bootstrap --reinstall` | 显式重装所选受管运行时，再检查准备 Git/gh；追加 --node 选择 Node |

默认命令现在会下载和写入。旧 --yes 不再接受；旧只读调用改为 --check。--check 与 --reinstall 不可合用。公开 setup 已移除并提示 bootstrap。重新执行 bootstrap 可恢复失效绑定；有效工具继续复用，不检查是否有更新。Git/gh 损坏副本可在归属明确时重新准备，未知文件保留并报告。

## 两阶段

```text
gidd.cmd bootstrap
  → 原生 Shell：检查/准备兼容运行时，发布 js_exec.cmd
  → 刚验证的运行时：执行 scripts/bootstrap-tools.mjs
      → 检查/准备 Git 与 gh
      → 发布 tool-bindings.json
  → 汇总两阶段结果

gidd.cmd identity/auth
  → js_exec.cmd → 当前技能的 scripts/gidd.mjs
  → 读取绑定，以绝对路径直接执行工具
```

原生 Shell 执行 JS 段时直接使用刚验证的运行时路径，避免 Unicode/百分号路径再经过一次批处理展开；普通命令仍通过共享 js_exec.cmd。阶段报告通过 UTF-8 stdin 交接，JS 接受管道开头的 BOM。--check 在启动器尚未发布时也可使用已验证候选完成 JS 检查；没有兼容候选时报告工具段 not_checked，不下载运行时。

两阶段分别持有并释放同一共享安装锁，不嵌套占用。JS 段失败不撤销已成功准备的运行时。Git 与 gh 各自提交绑定，一项失败仍检查/准备另一项；总体结果只有所有阶段成功才为 ready。bootstrap 不要求目标已执行 git init，不创建仓库、GitHub 配置、作者设置或登录状态。

## 版本与选择

版本要求由代码维护，config.toml 的工具表只提供下载 source；所有工具 version 字段和旧 [bootstrap] 表均为退役字段，须移除。当前最低要求为 Bun 1.4.2、Node 24.19.0、gh 2.98.0、Git 2.0.0。运行时规则集中于 scripts/runtime-compat.mjs，Git/gh 规则在 scripts/tools.mjs。

运行时顺序保持受管 Bun、受管 Node、PATH Bun、PATH Node。缺少合格候选时默认下载稳定 Bun；--node 只选择/准备 Node，缺少时下载最新 LTS。已有兼容 Node 不要求必须是 LTS。不会为了 Bun 偏好替换可用 Node。运行时只需要一种；开发双运行时仍由 dev.cmd .setup 管理。

Git/gh 优先受管副本，再复用仍有效的已绑定外部路径，再搜索 PATH。缺少合格副本时下载官方稳定 gh 或普通 Windows x64 MinGit。已有合格版本不因上游更新而升级。来源、实际版本和文件哈希记入安装记录；仓库不指定 gh 版本，也不提供 tools.git 字段。

## 普通执行与诊断

固定共享目录为 ~/.agents/skills.tools/gidd/。js_exec.cmd 绑定运行时；tool-bindings.json 使用 gidd.tool-bindings/v1，记录 Git、gh 的绝对路径、来源、上次验证版本，以及受管安装记录的 SHA-256。绑定不含仓库、账号或凭据，由 bootstrap 原子发布。修改共享绑定会影响本用户的所有仓库。

普通命令只解析绑定及其最低版本元数据，不搜索 PATH，不执行 --version，不遍历工具树或校验整套 payload。每个进程读取一次绑定，子调用复用绝对路径。Git 所在目录只放入子进程 PATH 最前，清除继承的 GIT_EXEC_PATH，保留用户模板等无关环境设置；系统与父进程 PATH 不变。不生成 gh_exec.cmd/git_exec.cmd 或 gh_exec.js/git_exec.js。

绑定缺失、格式错误、记录版本低于当前代码要求，或程序启动失败时提示重新 bootstrap。程序原路径被替换但仍可执行时，普通命令未必发现；绑定版本是上次验证记录。网络、认证和普通命令失败保持业务原因，不自动换工具或重跑业务。工具依赖损坏可能表现为普通执行失败，使用 bootstrap --check 或 doctor 进一步诊断。

doctor 与 bootstrap --check 做完整工具校验；doctor 还检查目标工作树和 GitHub 配置。help/config 不要求 Git/gh 绑定。auth 只强制要求 gh 绑定，存在 Git 绑定时共用它；不会因为绑定缺失而自动安装或登录。

## 发布与恢复

原生运行时发布保持既有协议：验证新副本后保留旧副本到 .cache/previous-bun 或 previous-node；共享启动器发布是提交点。发布前失败恢复旧副本，发布后只重试旧副本清理。未知文件、损坏归属记录或不明目录一律保留。--check 不做恢复。

Git/gh 使用同一下载、校验、锁、暂存流程，详见 [安装事务](setup.md)。受管损坏目录只有在安装清单可读、文件归属明确、没有额外文件或链接时才允许修复。新副本完全验证后，旧目录移至 .cache/previous-git 或 previous-gh，再发布新目录及绑定。

每次 Git/gh 安装记录新的 installation_id，确保同版本修复也能区分实例。绑定中的 record_sha256 是提交凭据：它匹配当前完整安装时，恢复只清理旧备份；否则恢复旧副本，再重试准备。已提交备份先改名为 .cache/retired-<tool>-<UUID> 后清理；占用导致的残留保留供后续清理。绑定发布前后中断均可重试，不自动覆盖未知恢复目标。损坏的生成绑定文件会先复制到 .cache/bindings-invalid-<UUID>.json 再重建。

运行时外部 Unicode 路径仍用 .runtime-path-<SHA256> 目录连接服务 ASCII 启动器。普通启动不调用 chcp，不改变控制台代码页。清理时只删除连接本身，不递归进入外部工具。安装记录提供损坏检测，不构成对可同时修改工具和记录的本机用户的安全隔离。

## 结果

公开 stdout 为 gidd.bootstrap/v1 JSON，包含 runtime、launcher、tools 和 tool_checks；read_only 区分 --check。ready 退出 0，needs_bootstrap 退出 1，参数或原生启动失败退出 2。各阶段错误可从检查项定位；工具段失败仍保留运行时结果。内部 JS 段独立结果为 gidd.bootstrap-tools/v1，不是第二个公开命令。stderr 显示下载与准备进度。

验证覆盖只读无写入、默认准备、Node 选择、固定绑定、业务失败不回退、完整性校验、跨 Shell/JS 锁、中断恢复、相同版本修复、未知文件保留、Unicode 路径，以及 Node/Bun 双运行时和真实官方下载。没有实际断电测试，不承诺任意文件系统下零丢失。
