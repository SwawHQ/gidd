# 仓库配置 v1

运行时由显式 [bootstrap](bootstrap.md) 选择、检查并发布共享启动器；兼容规则由 scripts/runtime-compat.mjs 内部维护。配置不提供运行时版本、偏好、安装目录或 bin 字段。

模板为 `assets/config.example.toml`，实例唯一位置为 `<目标仓库>/.agents/skills/gidd/config.toml`。技能安装位置与安装方式由 Agent 客户端处理；GIDD 不在配置中记录“用户级/仓库级”模式，也不需要客户端用户技能根目录来定位下载工具。

## 配置命令与 GitHub 身份

在目标仓库的 `.agents/skills/gidd/` 安装目录运行，入口自动定位所属仓库：

```text
gidd.cmd config show
gidd.cmd config set github.hostname github.com
gidd.cmd config set github.account octocat
gidd.cmd config set github.remote origin
gidd.cmd identity
gidd.cmd auth
```

`config show/set` 使用可用 Node/Bun 执行共用 `scripts/config.mjs`；入口直接通过共享 js_exec.cmd 启动，缺少启动器先执行 bootstrap --yes。`show` 只读；`set <字段> <值>` 支持下表全部可编辑字段，拒绝未知字段和凭据字段，`schema_version` 由程序管理。仍可手工编辑 TOML。首次 set 创建完整模板，明确写入 hostname=github.com、remote=origin；账号由用户指定。已有配置不自动补齐其他缺项，Agent 按提示逐项设置。

| 可编辑字段 | 值与用途 |
| --- | --- |
| `github.hostname` | GitHub 主机名，例如 `github.com` |
| `github.account` | 预期登录账号 |
| `github.remote` | Git remote 名称，例如 `origin` |
| `tools.gh.version` | `latest` 或确切版本 |
| `tools.node.source`、`tools.bun.source`、`tools.gh.source` | HTTPS 下载根，规则见下文 |

写入前直接使用 scripts/storage.mjs 校验完整配置，不回调 PowerShell；校验失败保留原文件。配置编辑不创建共享工具目录。内联表只替换指定字段的字符串，保留另一个字段、顺序、空格和行尾注释；原本省略整个工具行时，从模板补齐伴随字段，生成合法的完整内联表。

旧配置中的 [bootstrap]、tools.bun.version、tools.node.version 报 config_retired_field，不静默忽略。升级时手工移除这些已退役字段，保留其他内容和注释，再运行 bootstrap。修改下载来源或 gh 版本只影响后续显式安装，不改动共享启动器。

```toml
[github]
hostname = "github.com"
account = "octocat" # 预期登录身份，不是仓库所有者或 commit 作者
remote = "origin"  # Git remote 名称，不是 URL
```

身份检查必须从文件读取三项；授权只要求 hostname/account，remote 不参与授权。缺项或非法值时报错，提示设置；不从当前 gh 登录、Git remote、命令行参数或默认值推断。`identity/auth` 已移除 `--hostname`、`--account`、`--remote` 以及 `auth <账号>`；`dev.cmd .auth` 同样不接收账号。修改账号只改变预期身份，不登录、不切换账号、不修改 Git 配置，也不自动启用仓库。

编辑保留无关字段、注释、UTF-8 BOM 和原有换行。按白名单校验主机名、账号和 remote，保留已有非法/不支持的结构供人工修订，不重建文件来丢弃未知内容。stage0 用受限读取器检查启动配置，完整 schema、GitHub 字段值和所需字段由 JavaScript 校验；doctor 的工具配置就绪不代表身份配置齐备。

写入使用同目录临时文件、刷盘和原子替换，独占 `config.toml.lock` 防止 GIDD 编辑器相互覆盖；正常结束清理临时文件与锁。写入前发现文件已被外部修改时拒绝替换。进程被强制终止可能留下锁和临时文件；确认无配置编辑进程运行后才清理对应遗留文件并重试，不自动删除锁抢占。保留原文件不等于任意硬件断电下零丢失。

stdout 使用 `gidd.config/v1` JSON：成功退出 0，show 的 `content` 为文件原文；set 报告 `key`、`value` 和路径。错误退出 2，`reason` 描述缺项、非法值或文件锁等问题，stderr 提供修订提示。设置及展示不访问 GitHub，不读写凭据。

## 工具配置

```toml
schema_version = 1

[tools]
node = { source = "https://nodejs.org/dist" }
bun = { source = "https://github.com/oven-sh/bun/releases" }
gh = { version = "latest", source = "https://github.com/cli/cli/releases" }
```

`schema_version` 必须为整数 `1`，工具目录固定，不写入配置。node、bun 内联表只提供 source；gh 内联表提供 version 和 source。可以省略整个工具行使用默认来源和内部策略；写了工具行必须提供该工具全部公开字段。配置存在或工具可用不代表启用 GIDD、完成登录或具备 GitHub 权限。

## 版本与下载来源

Node LTS 与 Bun 稳定版是内部下载策略；gh 支持 `latest`（默认）或确切的 `x.y.z`。浮动版本只在需要下载安装时联网解析：Node 从官方 index.json 选择具有 Windows x64 ZIP 的最高匹配版本；Bun、gh 从官方 GitHub latest release 解析稳定 tag，拒绝 draft、prerelease 和非正式版本。API 不依赖已安装的 gh 或 GitHub 登录，限流或网络失败会报错，不静默改装其他版本。

bootstrap 优先复用通过兼容检查的运行时；gh 须满足自身最低版本要求，`lts/latest` 不要求每次检查时都更新到最新，也不联网证明复用的 Node 属于 LTS。gh 固定版本必须精确匹配；Bun/Node 没有仓库版本约束，bootstrap 使用独立兼容方法。技能仍只需 Node/Bun 之一，配置列出三个工具不表示必须安装全部三个。修改 source 只影响未来下载，不改变已复用工具的来源。

`source` 是 HTTPS 下载根，不是安装脚本或完整 ZIP URL。模板完整展示官方默认值。自定义镜像必须保留对应上游的目录布局：

- Node：`<source>/v<version>/node-v<version>-win-x64.zip`。
- Bun：`<source>/download/bun-v<version>/bun-windows-x64.zip`。
- gh：`<source>/download/v<version>/gh_<version>_windows_amd64.zip`。

版本元数据与 SHA-256 始终从官方上游 HTTPS 获取，镜像只替换归档下载；因此使用镜像仍需要访问官方元数据。Node、Bun 使用该版本的 SHASUMS256.txt，gh 使用 gh_<version>_checksums.txt；校验行缺失或重复时报错。Bun 许可证从官方版本 tag 获取并校验保存。安装前向 stderr 展示确切版本与完整归档 URL，install.json 记录实际版本、URL、SHA-256 及动态解析的元数据来源。这是基于 HTTPS 的来源与完整性校验，尚未验证发布签名。

为避免配置输出暴露凭据，source 禁止用户名、密码、query 和 fragment；不支持带 token 的 URL。下载仍有大小与超时限制。无法取得校验信息时不安装。

JS setup 遇到受管目录损坏或 gh 版本冲突时保留并报错。显式 bootstrap --yes 可修复归属明确且无其他合格候选的运行时；--reinstall --yes 可强制准备受管副本，协议见 bootstrap.md。运行时被占用而无法替换时保留并报错；gh 自动升级/回滚未实现。

安装只支持按配置联网下载或复用已有工具，不接受本地安装包目录。已安装且满足要求的工具直接复用，不联网。内置清单保留已验证确切版本的校验信息，不决定默认下载版本。

## 固定共享目录

工具统一存放于 `~/.agents/skills.tools/gidd/`，其中 `~` 是当前用户家目录。Windows 使用 USERPROFILE，未提供时使用系统用户目录；产品不修改该环境变量。目录不在 `~/.agents/skills/` 技能发现树内，不含 SKILL.md 或仓库配置。

`gidd.cmd` 与 `dev.cmd` 使用同一位置；仓库移动、当前工作目录、是否已有配置及技能安装位置均不改变它。配置决定下载来源及 gh 版本要求，不提供目录字段或路径覆盖参数。各工具占用固定 bun/、node/、gh/ 子目录；不同仓库要求不匹配的 gh 固定版本时报告冲突，不覆盖现有安装。

stage0 路径解析由 `scripts/windows/lib/_configuration.ps1` 完成，不依赖 Bun/Node；JS 使用 scripts/storage.mjs 读取同一规则。只读解析不建目录；bootstrap --yes 即使复用 PATH 也会建立共享目录来发布 js_exec.cmd 和 INSTALLATION.md。配置错误时 stage0 停止并报告启动失败；直接调用 JS doctor 时仍报告可检查的独立项目。

## 读取与校验

这是当前工具字段的受限 TOML 读取器，不是通用 TOML 实现。支持 UTF-8（可带 BOM）、LF/CRLF、空行、`#` 注释、裸字段名、`[tools]` / `[github]` 表、单行字符串及上述工具内联表。内联表两个字段可交换顺序，不支持跨行或尾随逗号。双引号字符串支持反斜杠与双引号的转义，单引号字符串按字面读取。

不支持引号字段名、点分字段、多行字符串、数组、其他内联表或其他字段、转义。重复字段（包括内联表内）、重复表、缺少必需字段、未知字段、其他 schema 版本、非 UTF-8 和超过 16 KiB 的文件均报错。读取不重写实例，保留注释与格式；显式 `config set` 可创建模板并修改上表中的 GitHub 与工具字段；完整技能安装与更新尚未实现。

当前验证平台为 Windows x64 / PowerShell 5.1，家目录须位于本地盘。拒绝路径经过或工具树内含 reparse point，工具树不得含 SKILL.md、config.toml 或 Git 元数据。

## 发布、提交与清理

gh 版本策略和各工具下载来源在仓库实例中，已解析版本和校验值在实际工具的 install.json 中。`assets/runtimes.json`（Bun/gh）与源码仓库的 `dev/runtimes.json`（开发 Node）保留已验证版本的校验信息；平台资产名称与提取规则由 stage0 releases.ps1 和 JS install.mjs 适配。每个实际工具根内的 INSTALLATION.md 说明来源与清理边界，不记录技能安装模式。

仓库实例只记录 gh 版本策略、下载来源和预期 GitHub 身份，可随源码审阅；不把整个 `.agents/` 默认视为应提交或应忽略。共享工具和下载缓存位于仓库外，不进入源码提交。

卸载当前仓库只处理 Agent 确认的技能目录与仓库配置，不自动删除共享工具。完整卸载须明确包含共享工具；清理前确认没有安装或运行进程。不得删除外部 PATH 工具，也不得把文件删除描述为撤销 GitHub 授权。
