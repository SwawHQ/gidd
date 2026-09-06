# 工具目录配置 v1

模板为 `assets/config.example.toml`，实例唯一位置为 `<目标仓库>/.agents/skills/gidd/config.toml`。技能安装位置与安装方式由 Agent 客户端处理；GIDD 不在配置中记录“用户级/仓库级”模式，也不需要客户端用户技能根目录来定位下载工具。

```toml
schema_version = 1

[tools]
directory = "~/.agents/skills/gidd.tools"
```

当前只有两个字段：`schema_version` 必须为整数 `1`，`tools.directory` 指定专用工具目录。原草案的 `tools.scope` 已移除，写入它会报未知字段错误。配置存在或工具可用不代表启用 GIDD、完成登录或具备 GitHub 权限。

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

这是当前工具字段的受限 TOML 读取器，不是通用 TOML 实现。支持 UTF-8（可带 BOM）、LF/CRLF、空行、`#` 注释、裸字段名、`[tools]` 表和单行字符串。双引号字符串支持反斜杠与双引号的转义，单引号字符串按字面读取；Windows 路径建议使用 `/`。引号内的 `#` 是路径字符。

不支持引号字段名、点分字段、多行字符串、数组、内联表或其他字段、转义。重复字段、重复表、缺少必需字段、未知字段、其他 schema 版本、非 UTF-8 和超过 16 KiB 的文件均报错。读取不重写实例，保留注释与格式；自动生成和修改已有实例尚未实现。

当前验证平台为 Windows x64 / PowerShell 5.1，只支持本地盘。允许路径末尾分隔符；拒绝 UNC、设备路径、盘符相对路径、`..`、内部空路径段、Windows 保留设备名、ADS、尾部点/空格和 `.git` 路径段。不得把盘符根或用户家目录本身作为工具目录。拒绝路径经过或工具树内含 reparse point，工具树也不能含 SKILL.md、config.toml 或 Git 元数据。

## 发布、提交与清理

URL、版本和 SHA-256 仍在发布清单 `assets/runtimes.json`（Bun/gh）与源码仓库的 `scripts/dev/runtimes.json`（开发 Node）。实例不覆盖下载来源、版本或校验值。每个实际工具根内的 INSTALLATION.md 说明来源与清理边界，不记录技能安装模式。

本源码仓库实例使用 `directory = ".devv"`，精确忽略 `/.devv/`。实例只含可移植的相对目录，可随源码审阅；不把整个 `.agents/` 默认视为应提交或应忽略。其他仓库自行决定实例提交策略，不提交下载工具、缓存、凭据或不适合共享的机器绝对路径。

修改 directory 不会自动迁移或删除旧工具。须明确迁移范围，在安装与测试退出且目标尚不存在时移动原目录，再运行 `.setup` 校验复用。任何目录都可能被多个仓库使用，不能仅凭路径位于某个仓库或某个用户目录内就推断引用数量。卸载技能本体时，由 Agent 确认其实际安装位置；清理工具时单独确认配置目录与旧目录的范围，不删除外部 PATH 工具，不把删除文件描述为撤销 GitHub 授权。
