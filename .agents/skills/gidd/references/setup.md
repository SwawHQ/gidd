# 工具安装与恢复

公开入口统一为 [bootstrap](bootstrap.md)。默认检查并补齐运行时、Git、gh；--check 只读。scripts/install.mjs 提供共用下载、解压和安装事务，scripts/bootstrap-tools.mjs 负责 Git/gh 准备、绑定和恢复。旧 setup 命令及旧 setup-tools.ps1 只报告退役提示。

工具固定存储于 ~/.agents/skills.tools/gidd/，不受技能安装位置影响：

- bun/、node/、gh/：程序、上游许可证和 install.json。
- git/：MinGit 完整文件树，包括 cmd/git.exe、mingw64/、usr/、etc/、LICENSE.txt 和 install.json。
- js_exec.cmd：共享运行时启动器；tool-bindings.json：Git/gh 路径绑定。
- .cache/：安装锁、对应工具的 download.part/payload、恢复备份与待清理数据。

source 可由仓库配置指定，版本要求和下载策略由代码维护。gh、Bun 缺少时解析稳定版，Node 解析 LTS；Git 从 [Git for Windows 官方发布](https://github.com/git-for-windows/git/releases) 解析普通 Windows x64 MinGit ZIP，不选择 BusyBox。已有合格版本继续复用。Git 暂无 tools.git 配置项。

[MinGit](https://gitforwindows.org/mingit.html) 面向应用程序调用，保留非交互 Git 依赖及许可证，不包含完整 Git for Windows 的 GUI、交互 Bash/Perl 工具集。不能单独复制 git.exe。准备工具不设置 Git 作者、remote、凭据或 GitHub 登录。

## 下载与完整性

安装前显示版本和完整 URL。归档必须核对官方 SHA-256；使用镜像也核对官方校验信息。MinGit 归档名称、URL、SHA-256 来自官方 release asset，缺少 digest 则停止。JS 每次下载总期限 30 秒、最多 256 MiB；原生 Shell 连接/空闲期限 30 秒。失败后显式重新 tools --ensure，不无限重试、不提供断点续传。

Bun/Node/gh 只提取允许列表内文件。Git 提取完整文件树并保留空文件；拒绝路径穿越、Windows 名称冲突、链接、特殊文件、加密、ZIP64 和多卷。限制 10000 个条目、512 MiB 解压总量和 256 MiB 单文件，校验 ZIP CRC。Git 必须包含 cmd/git.exe、mingw64/bin/git.exe、LICENSE.txt。

安装记录包含名称、平台、实际版本、来源、归档 SHA-256，以及每个文件的名称、长度和 SHA-256。Bun/Node/gh 使用 gidd.install/v1；Git 使用 gidd.install/v2，记录相对路径，最大 4 MiB。Git/gh 每次安装另有唯一 installation_id，绑定记录引用整个 install.json 的 SHA-256。第三方许可证保持原样，GIDD 的 MIT 不替代上游许可证。

## 安装锁与中断恢复

1. 在 .cache/ 下建立含 owner-<UUID>.json 的临时锁目录，再原子发布为 install.lock/。Shell/JS 使用同一协议。活进程或无法确认的所有者阻止竞争；确认死亡后只删除对应 marker 和空目录。PID 重用时保守拒绝。旧零字节句柄锁只在未被持有时迁移，非空未知文件保留。
2. 丢弃对应工具未完成暂存，下载并核对归档，提取到 .cache/<tool>/payload。可执行版本、文件哈希和安装清单通过后才发布。重试前扫描暂存路径，拒绝 reparse point，避免清理越界。
3. 初次安装同卷重命名 payload 到正式目录。修复先确认旧目录归属，验证新副本后把旧目录保留到 previous-<tool>。未知文件或不明安装记录不自动覆盖。
4. Git/gh 的路径绑定原子发布后才提交替换。恢复判定和运行时启动器提交点见 [bootstrap](bootstrap.md)。一项失败保留其他已完成工具。只读检查报告待恢复状态而不改变文件。
5. 成功后删除对应下载与暂存。绑定提交后的旧备份先改名为 retired-<tool>-<UUID> 再清理；清理失败报告问题并保留工作副本。用户不应在 .cache/ 保存自有数据，也不应删除活跃锁。

共享目录及子目录不得包含 SKILL.md、仓库 config.toml 或 Git 元数据。卸载一个仓库不删除共享工具；完整共享清理必须明确包含该范围。外部 PATH 工具不归 GIDD 管理，不删除它们或其目录连接目标。删除文件不等于退出 GitHub 或撤销授权。
