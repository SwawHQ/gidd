# Windows 工具初始化

先按 [doctor.md](doctor.md) 检查。用户已授权准备缺失工具后，从实际技能目录执行：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\windows\setup-tools.ps1 -UserSkillsRoot 'C:\Users\alice\.agents\skills'
```

只支持已验证的 Windows x64 / Windows PowerShell 5.1，本地盘绝对路径。用户技能目录可不存在；禁止路径经过 junction/symlink 等 reparse point，不修改用户技能目录位置选择。Node/Bun 任一种可用便复用；gh 可用也复用。所有工具均来自外部 PATH 且工具根不存在时，整个操作不建立目录。

## 存储与源码

```text
<用户技能根>/gidd.tools/
├── INSTALLATION.md       # 程序生成的用途、来源定位和清理说明
├── .install.lock         # 句柄锁文件；退出后可保留空文件
├── .install/             # 安装暂存，成功或下次显式重试时清理对应工具子目录
│   └── bun/              # gh 使用自己的 gh/；download.part、payload/
├── bun/
│   ├── bun.exe
│   ├── LICENSE.md
│   └── install.json
└── gh/
    ├── gh.exe
    ├── LICENSE
    └── install.json
```

`assets/runtimes.json` 固定版本、上游 HTTPS URL、归档 SHA-256、选取文件及额外许可材料。首版为 Bun 1.2.15、gh 2.98.0，不会查询或安装 latest。安装清单 `gidd.install/v1` 保存实际文件的名称、长度和 SHA-256，以及工具名、平台、版本和归档来源。第三方工具保持其原许可证，不套用 GIDD 的 MIT。

`scripts/windows/setup-tools/` 按 `_filesystem.ps1`（锁和受控路径）、`download.ps1`（下载与归档）、`install.ps1`（发布事务）拆分。真实共用的探测与完整性代码位于相邻 `lib/`。

## 中断恢复

1. 持有 `.install.lock` 的独占文件句柄后，再检查实际安装状态。竞争者立即返回错误，不通过删除锁文件抢锁；进程终止后操作系统释放句柄。
2. 丢弃对应 `.install/bun/` 或 `.install/gh/` 的未完成暂存，再下载到 `download.part`。文件 SHA-256 与受管清单不符时停止，不执行下载内容。网络等待有 30 秒连接/空闲超时，下载最大 256 MiB；失败后由用户或 Agent 显式重试，不无限循环。
3. 仅提取清单列出的文件，拒绝危险 ZIP 路径、重复或缺失的必需条目。可执行文件版本、所有文件哈希和安装清单均通过后，刷盘并同卷重命名整个 payload 到尚不存在的正式目录。
4. 中断发生在发布之前：正式目录不存在，下次重建暂存。发生在发布之后：重新校验正式目录，确认完整后复用并清理残留暂存，不再下载。
5. 正式目录损坏或不明归属时返回冲突，保留原文件；首版不提供自动升级或破坏性修复。`.install/` 是专用可丢弃暂存区，用户不要向其中保存文件。重试时扫描暂存树并拒绝 reparse point，避免清理越界。

Bun 与 gh 各自发布：Bun 完成而 gh 失败时，保留已完成的 Bun，下次只补缺项。文件哈希与刷盘用于识别损坏、降低丢失风险，不构成任意硬件和文件系统上断电零丢失的承诺。当前验证包括强制终止与残缺文件模拟，没有实际切断机器电源。

安装清单与 executable 同目录，SHA-256 提供完整性检查，不是对可同时修改两者的本机用户的安全隔离。它不保存 GitHub 凭据或仓库配置。

## 离线输入与输出

可选 `-ArchiveDirectory 'D:\downloads'` 从指定目录读取预先下载的官方文件，仍必须通过相同的固定 SHA-256。所需文件名：`bun-windows-x64.zip`、`gh_2.98.0_windows_amd64.zip`，Bun 另需 `bun-1.2.15-LICENSE.md`。文件只在需要安装对应工具时读取；此参数不改变正式安装位置。官方 URL 与哈希均在 `assets/runtimes.json`，不接受任意清单或跳过校验开关。

stdout 是 `gidd.setup-tools/v1` JSON；成功退出 0，`status=ready`，`tools` 列出 `installed` 或 `reused` 及实际路径。失败退出 1，`status=error`，`reason` 提供原因，`tools` 保留已完成项；stderr 显示进度与错误。`install_locked_or_unwritable` 需要确认另一个安装是否在运行；`occupied_or_invalid_target` 需要检查该正式目录，不要直接删除。

成功后再次运行 doctor。`ready` 只表示运行时与 gh 可用；Git、仓库、配置和认证仍需各自检查。仓库配置写入、登录与完整开发流程尚未实现，不能报告“仓库已启用”。
