# Windows 工具初始化

先按 [doctor.md](doctor.md) 检查。用户已授权准备缺失工具后，从实际技能目录执行：

```powershell
.\gidd.cmd setup bun
.\gidd.cmd setup node
.\gidd.cmd setup gh
```

只支持已验证的 Windows x64 / Windows PowerShell 5.1，本地盘绝对路径。工具目录可不存在；禁止路径经过 junction/symlink 等 reparse point。技能安装由 Agent 管理，工具初始化不需要其安装模式或安装目录。Node/Bun 任一种可用便复用；gh 可用也复用。所有工具均来自外部 PATH 且工具根不存在时，整个操作不建立目录。

入口位于 `<目标仓库>/.agents/skills/gidd/` 且仓库根有 `.git` 标记时，从自身位置定位目标，支持 Git worktree；不依赖工作目录。先读取目标仓库的固定配置；无配置使用默认共享目录，配置错误停止安装，规则与模板见 [configuration.md](configuration.md)。工具准备不会自动创建或修改 config.toml。

## 存储与源码

`setup` 不指定工具时保持准备一种运行时与 gh 的行为；`setup bun` 即使已有 Node 也只准备 Bun，`setup gh` 不要求 Node/Bun 并要求 gh 2.98.0+，适用于设备授权准备。显式选择工具时，不安装或清理其他工具的受管目录，也不因其损坏而阻止当前工具准备；诊断式工具探测仍可能读取它们。固定版本仍须精确匹配。`setup node` 只准备 Node，默认下载 LTS，仅提取 node.exe 和 LICENSE，不含 npm；最低诊断门槛为 Node 22。公开入口复用内部 `scripts/windows/setup-tools.ps1`（可选 `-Tool bun|node|gh`）及现有安装、校验、锁与恢复实现，保留结果 JSON 和退出码。

以下工具根默认是 `~/.agents/skills/gidd.tools/`，可由仓库配置覆盖：

```text
<工具根>/
├── INSTALLATION.md       # 程序生成的用途、来源定位和清理说明
├── .cache/               # 安装缓存区，不长期保留下载包
│   ├── install.lock      # 句柄锁文件；退出后保留空文件
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

config.toml 的工具内联表指定版本和下载根；默认缺失工具下载 Node LTS 或最新稳定 Bun/gh，解析规则见 [configuration.md](configuration.md)。安装前显示确切版本与完整下载 URL，官方校验信息缺失时报错；镜像归档仍对照官方 SHA-256。`assets/runtimes.json` 保留 Bun 1.2.15、gh 2.98.0 的校验信息。安装清单 `gidd.install/v1` 保存实际文件的名称、长度和 SHA-256，以及工具名、平台、版本和归档来源。第三方工具保持其原许可证，不套用 GIDD 的 MIT。

`scripts/windows/setup-tools/` 按 `_filesystem.ps1`（锁和受控路径）、`releases.ps1`（版本与官方校验元数据）、`download.ps1`（下载与归档）、`install.ps1`（发布事务）拆分。真实共用的配置、探测与完整性代码位于相邻 `lib/`。

实际工具根直接包含 `.cache/`、`bun/`、`node/`、`gh/`，按需建立。源码仓库开发入口读取同一配置，可分别准备 Bun、Node 或 gh；技能入口通过 `setup node` 显式准备 Node，未指定工具的 setup 仍只需一种运行时。配置相同时两入口共用工具和安装锁，配置的实际路径不同则分别管理。

## 中断恢复

1. 持有 `.cache/install.lock` 的独占文件句柄后，再检查实际安装状态。竞争者立即返回错误，不通过删除锁文件抢锁；进程终止后操作系统释放句柄。
2. 丢弃对应 `.cache/bun/`、`.cache/node/` 或 `.cache/gh/` 的未完成暂存，再下载到 `download.part`。文件 SHA-256 与受管清单不符时停止，不执行下载内容。网络等待有 30 秒连接/空闲超时，下载最大 256 MiB；失败后由用户或 Agent 显式重试，不无限循环。
3. 仅提取清单列出的文件，拒绝危险 ZIP 路径、重复或缺失的必需条目。可执行文件版本、所有文件哈希和安装清单均通过后，刷盘并同卷重命名整个 payload 到尚不存在的正式目录。
4. 中断发生在发布之前：正式目录不存在，下次重建暂存。发生在发布之后：重新校验正式目录，确认完整后复用并清理残留暂存，不再下载。
5. 正式目录损坏、不明归属或不满足配置版本时返回冲突，保留原文件；不提供自动升级/回滚或破坏性修复。固定版本改变不会自动替换已有目录。`.cache/` 是专用安装缓存区，用户不要向其中保存文件。自动清理只删除对应工具子目录，保留 `.cache/` 与 `install.lock`；安装运行期间不得删除缓存根或锁文件。重试时扫描暂存树并拒绝 reparse point，避免清理越界。

下载包在成功后删除，中断重试重新下载，不提供断点续传。旧版本的 `.install/` 和 `.install.lock` 不参与新布局；确认所有安装进程退出后可清理这些遗留路径，切勿同时运行新旧安装器。

Bun 与 gh 各自发布：Bun 完成而 gh 失败时，保留已完成的 Bun，下次只补缺项。文件哈希与刷盘用于识别损坏、降低丢失风险，不构成任意硬件和文件系统上断电零丢失的承诺。当前验证包括强制终止与残缺文件模拟，没有实际切断机器电源。

安装清单与 executable 同目录，SHA-256 提供完整性检查，不是对可同时修改两者的本机用户的安全隔离。它不保存 GitHub 凭据或仓库配置。

## 输出

缺失工具按配置联网下载并校验；已有可用工具直接复用。入口不接受本地安装包目录、任意清单或跳过校验开关。

stdout 是 `gidd.setup-tools/v1` JSON；成功退出 0，`status=ready`，`tools` 列出 `installed` 或 `reused` 及实际路径。失败退出 1，`status=error`，`reason` 提供原因，`tools` 保留已完成项；stderr 显示进度与错误。`install_locked_or_unwritable` 需要确认另一个安装是否在运行；`occupied_or_invalid_target` 需要检查该正式目录，不要直接删除。

成功后再次运行 doctor。`ready` 只表示本次所选工具可用（不指定工具时为一种运行时与 gh）；Git、仓库、配置和认证仍需各自检查。需要检查账号时使用 [身份检查](identity.md)，用户明确要求登录时使用 [设备授权](authorization.md)。配置可用 `config show/set` 管理；完整技能安装、启用记录与完整开发流程尚未实现，不能报告“仓库已启用”。
