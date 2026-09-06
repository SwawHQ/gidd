# 工具配置 v1

模板为 `assets/config.example.toml`，实例唯一位置为 `<目标仓库>/.agents/skills/gidd/config.toml`。技能安装位置与安装方式由 Agent 客户端处理；GIDD 不在配置中记录“用户级/仓库级”模式，也不需要客户端用户技能根目录来定位下载工具。

```toml
schema_version = 1

[tools]
directory = "~/.agents/skills/gidd.tools"
node = { version = "lts", source = "https://nodejs.org/dist" }
bun = { version = "latest", source = "https://github.com/oven-sh/bun/releases" }
gh = { version = "latest", source = "https://github.com/cli/cli/releases" }
```

`schema_version` 必须为整数 `1`，`tools.directory` 指定专用工具目录。node、bun、gh 各用一行内联表，显式展示 version 和 source。可以省略整个工具行，此时使用上例默认值；写了工具行则须同时提供这两个字段。原草案的 `tools.scope` 已移除，写入它会报未知字段错误。配置存在或工具可用不代表启用 GIDD、完成登录或具备 GitHub 权限。

## 版本与下载来源

Node 支持 `lts`（默认）、`latest` 或确切的 `x.y.z`；Bun、gh 支持 `latest`（默认）或确切版本。浮动版本只在需要下载安装时联网解析：Node 从官方 index.json 选择具有 Windows x64 ZIP 的最高匹配版本；Bun、gh 从官方 GitHub latest release 解析稳定 tag，拒绝 draft、prerelease 和非正式版本。API 不依赖已安装的 gh 或 GitHub 登录，限流或网络失败会报错，不静默改装其他版本。

优先复用达到最低版本要求的现有工具，`lts/latest` 不要求每次检查时都更新到最新，也不联网证明复用的 Node 属于 LTS。固定版本必须精确匹配；doctor 和开发测试均应用这个约束。技能仍只需 Node/Bun 之一，配置列出三个工具不表示必须安装全部三个。修改 source 只影响未来下载，不改变已复用工具的来源。

`source` 是 HTTPS 下载根，不是安装脚本或完整 ZIP URL。模板完整展示官方默认值。自定义镜像必须保留对应上游的目录布局：

- Node：`<source>/v<version>/node-v<version>-win-x64.zip`。
- Bun：`<source>/download/bun-v<version>/bun-windows-x64.zip`。
- gh：`<source>/download/v<version>/gh_<version>_windows_amd64.zip`。

版本元数据与 SHA-256 始终从官方上游 HTTPS 获取，镜像只替换归档下载；因此使用镜像仍需要访问官方元数据。Node、Bun 使用该版本的 SHASUMS256.txt，gh 使用 gh_<version>_checksums.txt；校验行缺失或重复时报错。Bun 许可证从官方版本 tag 获取并校验保存。安装前向 stderr 展示确切版本与完整归档 URL，install.json 记录实际版本、URL、SHA-256 及动态解析的元数据来源。这是基于 HTTPS 的来源与完整性校验，尚未验证发布签名。

为避免配置输出暴露凭据，source 禁止用户名、密码、query 和 fragment；不支持带 token 的 URL。下载仍有大小与超时限制。无法取得校验信息时不安装。

已有受管目录不自动覆盖：版本冲突或文件损坏时报错并保留。改变固定版本不等于已完成升级；自动升级/回滚命令尚未实现。需要更换版本时可先配置另一个专用目录安装验证，旧目录按实际引用另行清理。

显式 `-ArchiveDirectory` 保持离线：已安装且满足要求的工具直接复用；首次离线安装只支持 runtimes.json 中保留校验信息的确切版本，须在配置中固定该版本。`lts/latest` 或其他未内置版本缺少离线元数据时返回 offline_release_metadata_unavailable，不偷偷联网。内置清单用于离线基线，不再决定默认下载版本。

## 路径含义

| directory 示例 | 实际位置 |
| --- | --- |
| `~/.agents/skills/gidd.tools` | 当前操作系统用户家目录下的专用工具目录，推荐值 |
| `.devv` 或 `./.devv` | 目标仓库根目录下的 `.devv/` |
| `D:/tools/gidd` | 用户指定的 Windows 本地盘绝对目录，可在仓库外 |

`~` 使用当前操作系统用户的家目录，独立于 Agent 客户端的技能扫描路径。推荐在 `~/.agents/skills/` 下使用 `gidd.tools/` 专用子目录，避免将下载工具与技能文件混放；用户可选择其他专用位置。脚本不会修改 HOME、USERPROFILE、PATH 或客户端设置，也不展开其他环境变量和 `~用户名`。

相对路径以目标仓库根目录为基准，不以当前 shell 工作目录或技能安装目录为基准。doctor 与 setup-tools 只需显式传入 `-RepositoryPath`，不再接收 `-UserSkillsRoot`；开发入口从自身源码目录定位仓库，不再读取 `GIDD_USER_SKILLS_ROOT`。

没有配置文件时，技能工具入口默认 `~/.agents/skills/gidd.tools`，开发入口默认 `<仓库>/.dev/`。有配置时三个入口都使用 tools.directory，不做跨配置文件继承。无效配置直接报错，禁止回退默认目录继续安装；doctor 仍检查外部 PATH 工具及其他独立项目，并标明未检查受管工具。

Windows 启动解析由 `scripts/windows/lib/_configuration.ps1` 完成，不依赖 Bun、Node、Git 或额外模块。启动时从明确目标向上寻找最近的 `.git` 标记；没有标记时使用显式传入的目录。调用方应传目标仓库根目录；doctor 另用 Git 验证工作树，路径定位本身不等于 Git 验证通过。

## 读取与校验

这是当前工具字段的受限 TOML 读取器，不是通用 TOML 实现。支持 UTF-8（可带 BOM）、LF/CRLF、空行、`#` 注释、裸字段名、`[tools]` 表、单行字符串及上述工具内联表。内联表两个字段可交换顺序，不支持跨行或尾随逗号。双引号字符串支持反斜杠与双引号的转义，单引号字符串按字面读取；Windows 路径建议使用 `/`。引号内的 `#` 是路径字符。

不支持引号字段名、点分字段、多行字符串、数组、其他内联表或其他字段、转义。重复字段（包括内联表内）、重复表、缺少必需字段、未知字段、其他 schema 版本、非 UTF-8 和超过 16 KiB 的文件均报错。读取不重写实例，保留注释与格式；自动生成和修改已有实例尚未实现。

当前验证平台为 Windows x64 / PowerShell 5.1，只支持本地盘。允许路径末尾分隔符；拒绝 UNC、设备路径、盘符相对路径、`..`、内部空路径段、Windows 保留设备名、ADS、尾部点/空格和 `.git` 路径段。不得把盘符根或用户家目录本身作为工具目录。拒绝路径经过或工具树内含 reparse point，工具树也不能含 SKILL.md、config.toml 或 Git 元数据。

## 发布、提交与清理

版本策略和下载来源在仓库实例中，已解析版本和校验值在实际工具的 install.json 中。`assets/runtimes.json`（Bun/gh）与源码仓库的 `scripts/dev/runtimes.json`（开发 Node）保留已验证版本的离线安装基线；平台资产名称与提取规则由 releases.ps1 适配。每个实际工具根内的 INSTALLATION.md 说明来源与清理边界，不记录技能安装模式。

本源码仓库实例使用 `directory = ".devv"`，精确忽略 `/.devv/`。实例只含可移植的相对目录，可随源码审阅；不把整个 `.agents/` 默认视为应提交或应忽略。其他仓库自行决定实例提交策略，不提交下载工具、缓存、凭据或不适合共享的机器绝对路径。

修改 directory 不会自动迁移或删除旧工具。须明确迁移范围，在安装与测试退出且目标尚不存在时移动原目录，再运行 `.setup` 校验复用。任何目录都可能被多个仓库使用，不能仅凭路径位于某个仓库或某个用户目录内就推断引用数量。卸载技能本体时，由 Agent 确认其实际安装位置；清理工具时单独确认配置目录与旧目录的范围，不删除外部 PATH 工具，不把删除文件描述为撤销 GitHub 授权。
