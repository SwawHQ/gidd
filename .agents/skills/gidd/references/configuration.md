# 仓库配置 v1

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

`config show/set` 使用可用 Node/Bun 执行共用 `scripts/config.mjs`；缺少运行时时先显式 `setup bun` 或 `setup node`，不会自动安装。`show` 只读；`set <字段> <值>` 支持下表全部可编辑字段，拒绝未知字段和凭据字段，`schema_version` 由程序管理。仍可手工编辑 TOML。首次 set 创建完整模板，明确写入 hostname=github.com、remote=origin；账号由用户指定。已有配置不自动补齐其他缺项，Agent 按提示逐项设置。

| 可编辑字段 | 值与用途 |
| --- | --- |
| `github.hostname` | GitHub 主机名，例如 `github.com` |
| `github.account` | 预期登录账号 |
| `github.remote` | Git remote 名称，例如 `origin` |
| `tools.node.version` | `lts`、`latest` 或确切版本 |
| `tools.bun.version`、`tools.gh.version` | `latest` 或确切版本 |
| `tools.node.source`、`tools.bun.source`、`tools.gh.source` | HTTPS 下载根，规则见下文 |

工具字段写入前，以临时配置调用同一 PowerShell schema 与共享工具目录校验器；校验失败保留原文件，不创建共享工具目录。内联表只替换指定字段的字符串，保留另一个字段、顺序、空格和行尾注释；原本省略整个工具行时，从模板补齐伴随字段，生成合法的完整内联表。

配置编辑器按最低可运行版本复用 PATH 或当前共享目录中的 Node/Bun，不要求匹配配置版本，避免刚设置新版本就无法继续编辑。其他命令仍遵守原来的版本要求。修改版本或来源只影响后续操作，不立即下载或升级工具。

```toml
[github]
hostname = "github.com"
account = "octocat" # 预期登录身份，不是仓库所有者或 commit 作者
remote = "origin"  # Git remote 名称，不是 URL
```

身份检查必须从文件读取三项；授权只要求 hostname/account，remote 不参与授权。缺项或非法值时报错，提示设置；不从当前 gh 登录、Git remote、命令行参数或默认值推断。`identity/auth` 已移除 `--hostname`、`--account`、`--remote` 以及 `auth <账号>`；`dev.cmd .auth` 同样不接收账号。修改账号只改变预期身份，不登录、不切换账号、不修改 Git 配置，也不自动启用仓库。

编辑保留无关字段、注释、UTF-8 BOM 和原有换行。按白名单校验主机名、账号和 remote，保留已有非法/不支持的结构供人工修订，不重建文件来丢弃未知内容。完整启动 schema 由 Shell 校验，GitHub 字段值和所需字段由 JavaScript 校验；doctor 的工具配置就绪不代表身份配置齐备。

写入使用同目录临时文件、刷盘和原子替换，独占 `config.toml.lock` 防止 GIDD 编辑器相互覆盖；正常结束清理临时文件与锁。写入前发现文件已被外部修改时拒绝替换。进程被强制终止可能留下锁和临时文件；确认无配置编辑进程运行后才清理对应遗留文件并重试，不自动删除锁抢占。保留原文件不等于任意硬件断电下零丢失。

stdout 使用 `gidd.config/v1` JSON：成功退出 0，show 的 `content` 为文件原文；set 报告 `key`、`value` 和路径。错误退出 2，`reason` 描述缺项、非法值或文件锁等问题，stderr 提供修订提示。设置及展示不访问 GitHub，不读写凭据。

## 工具配置

```toml
schema_version = 1

[tools]
node = { version = "lts", source = "https://nodejs.org/dist" }
bun = { version = "latest", source = "https://github.com/oven-sh/bun/releases" }
gh = { version = "latest", source = "https://github.com/cli/cli/releases" }
```

`schema_version` 必须为整数 `1`，工具目录固定，不写入配置。node、bun、gh 各用一行内联表，显式展示 version 和 source。可以省略整个工具行，此时使用上例默认值；写了工具行则须同时提供这两个字段。配置存在或工具可用不代表启用 GIDD、完成登录或具备 GitHub 权限。

## 版本与下载来源

Node 支持 `lts`（默认）、`latest` 或确切的 `x.y.z`；Bun、gh 支持 `latest`（默认）或确切版本。浮动版本只在需要下载安装时联网解析：Node 从官方 index.json 选择具有 Windows x64 ZIP 的最高匹配版本；Bun、gh 从官方 GitHub latest release 解析稳定 tag，拒绝 draft、prerelease 和非正式版本。API 不依赖已安装的 gh 或 GitHub 登录，限流或网络失败会报错，不静默改装其他版本。

优先复用达到最低版本要求的现有工具，`lts/latest` 不要求每次检查时都更新到最新，也不联网证明复用的 Node 属于 LTS。固定版本必须精确匹配；doctor 和开发测试均应用这个约束。技能仍只需 Node/Bun 之一，配置列出三个工具不表示必须安装全部三个。修改 source 只影响未来下载，不改变已复用工具的来源。

`source` 是 HTTPS 下载根，不是安装脚本或完整 ZIP URL。模板完整展示官方默认值。自定义镜像必须保留对应上游的目录布局：

- Node：`<source>/v<version>/node-v<version>-win-x64.zip`。
- Bun：`<source>/download/bun-v<version>/bun-windows-x64.zip`。
- gh：`<source>/download/v<version>/gh_<version>_windows_amd64.zip`。

版本元数据与 SHA-256 始终从官方上游 HTTPS 获取，镜像只替换归档下载；因此使用镜像仍需要访问官方元数据。Node、Bun 使用该版本的 SHASUMS256.txt，gh 使用 gh_<version>_checksums.txt；校验行缺失或重复时报错。Bun 许可证从官方版本 tag 获取并校验保存。安装前向 stderr 展示确切版本与完整归档 URL，install.json 记录实际版本、URL、SHA-256 及动态解析的元数据来源。这是基于 HTTPS 的来源与完整性校验，尚未验证发布签名。

为避免配置输出暴露凭据，source 禁止用户名、密码、query 和 fragment；不支持带 token 的 URL。下载仍有大小与超时限制。无法取得校验信息时不安装。

已有受管目录不自动覆盖：版本冲突或文件损坏时报错并保留。改变固定版本不等于已完成升级；自动升级/回滚命令尚未实现。更换共享工具版本前，应确认使用该工具的仓库和进程，备份现有工具后再显式安装并验证；不得在其他进程使用期间替换。

安装只支持按配置联网下载或复用已有工具，不接受本地安装包目录。已安装且满足要求的工具直接复用，不联网。内置清单保留已验证确切版本的校验信息，不决定默认下载版本。

## 固定共享目录

工具统一存放于 `~/.agents/skills.tools/gidd/`，其中 `~` 是当前用户家目录。Windows 使用 USERPROFILE，未提供时使用系统用户目录；产品不修改该环境变量。目录不在 `~/.agents/skills/` 技能发现树内，不含 SKILL.md 或仓库配置。

`gidd.cmd` 与 `dev.cmd` 使用同一位置；仓库移动、当前工作目录、是否已有配置及技能安装位置均不改变它。配置只决定版本要求和下载来源，不提供目录字段或路径覆盖参数。各工具占用固定 bun/、node/、gh/ 子目录；不同仓库要求不匹配的固定版本时报告冲突，不覆盖现有安装。

路径解析由 `scripts/windows/lib/_configuration.ps1` 完成，不依赖 Bun/Node。只读解析不建目录；复用 PATH 工具也不创建存储。配置错误时停止受管工具操作，doctor 仍报告可检查的独立项目。

## 读取与校验

这是当前工具字段的受限 TOML 读取器，不是通用 TOML 实现。支持 UTF-8（可带 BOM）、LF/CRLF、空行、`#` 注释、裸字段名、`[tools]` / `[github]` 表、单行字符串及上述工具内联表。内联表两个字段可交换顺序，不支持跨行或尾随逗号。双引号字符串支持反斜杠与双引号的转义，单引号字符串按字面读取。

不支持引号字段名、点分字段、多行字符串、数组、其他内联表或其他字段、转义。重复字段（包括内联表内）、重复表、缺少必需字段、未知字段、其他 schema 版本、非 UTF-8 和超过 16 KiB 的文件均报错。读取不重写实例，保留注释与格式；显式 `config set` 可创建模板并修改上表中的 GitHub 与工具字段；完整技能安装与更新尚未实现。

当前验证平台为 Windows x64 / PowerShell 5.1，家目录须位于本地盘。拒绝路径经过或工具树内含 reparse point，工具树不得含 SKILL.md、config.toml 或 Git 元数据。

## 发布、提交与清理

版本策略和下载来源在仓库实例中，已解析版本和校验值在实际工具的 install.json 中。`assets/runtimes.json`（Bun/gh）与源码仓库的 `scripts/dev/runtimes.json`（开发 Node）保留已验证版本的校验信息；平台资产名称与提取规则由 releases.ps1 适配。每个实际工具根内的 INSTALLATION.md 说明来源与清理边界，不记录技能安装模式。

仓库实例只记录版本策略、下载来源和预期 GitHub 身份，可随源码审阅；不把整个 `.agents/` 默认视为应提交或应忽略。共享工具和下载缓存位于仓库外，不进入源码提交。

卸载当前仓库只处理 Agent 确认的技能目录与仓库配置，不自动删除共享工具。完整卸载须明确包含共享工具；清理前确认没有安装或运行进程。不得删除外部 PATH 工具，也不得把文件删除描述为撤销 GitHub 授权。
