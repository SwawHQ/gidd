# Windows 工具初始化

先用显式 [bootstrap](bootstrap.md) 准备共享 js_exec.cmd。setup 普通入口不调用 PowerShell，由 scripts/install.mjs 执行指定工具准备；gh 安装全部在 JavaScript 中。

先按 [doctor.md](doctor.md) 检查。用户已授权准备缺失工具后，从实际技能目录执行：

```powershell
.\gidd.cmd setup bun
.\gidd.cmd setup node
.\gidd.cmd setup gh
```

只支持已验证的 Windows x64 / Windows PowerShell 5.1，本地盘绝对路径。工具目录可不存在；禁止路径经过 junction/symlink 等 reparse point。技能安装由 Agent 管理，工具初始化不需要其安装模式或安装目录。Node/Bun 任一种可用便复用；gh 可用也复用。所有工具均来自外部 PATH 且工具根不存在时，整个操作不建立目录。

入口位于 `<目标仓库>/.agents/skills/gidd/` 且仓库根有 `.git` 标记时，从自身位置定位目标，支持 Git worktree；不依赖工作目录。先读取目标仓库的固定配置；工具始终使用固定共享目录，配置错误停止安装，规则与模板见 [configuration.md](configuration.md)。工具准备不会自动创建或修改 config.toml。

## 存储与源码

setup 默认报告当前执行运行时已复用，并准备 gh；显式 setup bun/node/gh 只准备指定工具，不切换或发布共享启动器。没有启动器时先执行 bootstrap --yes；直接选择 Node 使用 bootstrap --node --yes。gh 要求 2.98.0+ 且遵守固定版本；Bun 稳定版与 Node LTS 为内部策略，Node 仅提取 node.exe 和 LICENSE，不含 npm。旧 scripts/windows/setup-tools.ps1 仅经共享启动器转发。

工具根固定为 `~/.agents/skills.tools/gidd/`，各仓库和开发入口共用：

```text
<工具根>/
├── INSTALLATION.md       # 程序生成的用途、来源定位和清理说明
├── js_exec.cmd          # bootstrap 发布，只绑定运行时
├── .cache/               # 安装缓存区，不长期保留下载包
│   ├── install.lock/     # 原子发布的锁目录；正常退出删除
│   └── bun/              # gh 使用自己的 gh/；download.part、payload/
├── bun/
│   ├── bun.exe
│   ├── LICENSE.md
│   └── install.json
├── node/                # setup node 按需准备，不含 npm
│   ├── node.exe
│   ├── LICENSE
│   └── install.json
└── gh/
    ├── gh.exe
    ├── LICENSE
    └── install.json
```

config.toml 指定各工具下载根及 gh 版本；默认缺失工具下载 Node LTS 或最新稳定 Bun/gh，解析规则见 [configuration.md](configuration.md)。安装前显示确切版本与完整下载 URL，官方校验信息缺失时报错；镜像归档仍对照官方 SHA-256。`assets/runtimes.json` 保留 Bun 1.2.15、gh 2.98.0 的校验信息。安装清单 `gidd.install/v1` 保存实际文件的名称、长度和 SHA-256，以及工具名、平台、版本和归档来源。第三方工具保持其原许可证，不套用 GIDD 的 MIT。

scripts/install.mjs 负责 JS 下载、校验、受控 ZIP 解压、安装事务和恢复。scripts/windows/setup-tools/ 保留显式 bootstrap 准备和修复运行时所需实现。两者遵守相同安装清单、锁和固定路径规则；测试对两份实现运行相同 fixture，并验证跨实现争锁。

实际工具根直接包含 `.cache/`、`bun/`、`node/`、`gh/`，按需建立。源码仓库开发入口读取同一配置，可分别准备 Bun、Node 或 gh；技能入口通过 `setup node` 显式准备 Node，未指定工具的 setup 仍只需一种运行时。同一用户的所有仓库和两类入口共用工具目录及安装锁。

## 中断恢复

1. 先在唯一临时目录写入并刷盘 owner-<UUID>.json（进程 ID、随机标识），再原子发布为 .cache/install.lock/。活进程或无法确认的所有者阻止竞争者；确认进程不存在后，只删除该所有者的唯一 marker，再删除空锁目录。唯一文件名防止回收者删除新所有者的 marker。PID 重用时保守拒绝，需等待对应进程退出。旧版的空句柄锁文件只在未被持有时迁移，非空文件保留并报错。
2. 丢弃对应 `.cache/bun/`、`.cache/node/` 或 `.cache/gh/` 的未完成暂存，再下载到 `download.part`。文件 SHA-256 与受管清单不符时停止，不执行下载内容。Shell 网络等待有 30 秒连接/空闲超时，JS 每次下载有 30 秒总期限，下载最大 256 MiB；失败后由用户或 Agent 显式重试，不无限循环。
3. 仅提取清单列出的文件，拒绝危险 ZIP 路径、重复或缺失的必需条目。可执行文件版本、所有文件哈希和安装清单均通过后，刷盘并同卷重命名整个 payload 到尚不存在的正式目录。
4. 中断发生在发布之前：正式目录不存在，下次重建暂存。发生在发布之后：重新校验正式目录，确认完整后复用并清理残留暂存，不再下载。
5. 正式目录损坏、不明归属或不满足配置版本时返回冲突，保留原文件；JS setup 不修复或覆盖；运行时修复由显式 bootstrap 提供备份与回滚，见 bootstrap.md。gh 固定版本改变不会自动替换已有目录。`.cache/` 是专用安装缓存区，用户不要向其中保存文件。自动清理只删除对应工具子目录，保留 `.cache/`；锁由持有者在退出时释放；安装运行期间不得删除缓存根或锁文件。重试时扫描暂存树并拒绝 reparse point，避免清理越界。

下载包在成功后删除，中断重试重新下载，不提供断点续传。

Bun 与 gh 各自发布：Bun 完成而 gh 失败时，保留已完成的 Bun，下次只补缺项。文件哈希与刷盘用于识别损坏、降低丢失风险，不构成任意硬件和文件系统上断电零丢失的承诺。当前验证包括强制终止与残缺文件模拟，没有实际切断机器电源。

安装清单与 executable 同目录，SHA-256 提供完整性检查，不是对可同时修改两者的本机用户的安全隔离。它不保存 GitHub 凭据或仓库配置。

## 输出

缺失工具按配置联网下载并校验；已有可用工具直接复用。入口不接受本地安装包目录、任意清单或跳过校验开关。

stdout 是 `gidd.setup-tools/v1` JSON；成功退出 0，`status=ready`，`tools` 列出 `installed` 或 `reused` 及实际路径。JS 安装失败退出 1，`status=error`，`reason` 提供原因；已完成的工具保留在磁盘供下次重试复用。启动器缺失使用 gidd.cli/v1、reason=bootstrap_required、退出 2；stderr 显示进度与错误。`install_locked_or_unwritable` 需要确认另一个安装是否在运行；`occupied_or_invalid_target` 需要检查该正式目录，不要直接删除。

成功后再次运行 doctor。`ready` 只表示本次所选工具可用（不指定工具时为一种运行时与 gh）；Git、仓库、配置和认证仍需各自检查。需要检查账号时使用 [身份检查](identity.md)，用户明确要求登录时使用 [设备授权](authorization.md)。配置可用 `config show/set` 管理；完整技能安装、启用记录与完整开发流程尚未实现，不能报告“仓库已启用”。
