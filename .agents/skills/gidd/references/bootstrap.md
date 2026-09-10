# 显式 bootstrap 与共享 JavaScript 启动器

Windows x64 / Windows PowerShell 5.1；本轮由 [Issue #23](https://github.com/SwawHQ/gidd/issues/23) 跟踪，基于 #21 的 JavaScript 迁移。Linux/macOS 的 js_exec.sh 尚未实现或验证。

## 命令

| 命令 | 行为 |
| --- | --- |
| `gidd.cmd bootstrap` | 只读检查兼容运行时及共享启动器是否与选择一致 |
| `gidd.cmd bootstrap --yes` | 允许准备缺失运行时，并生成或更新共享启动器 |
| `gidd.cmd bootstrap --node` | 只读检查 Node 候选和启动器 |
| `gidd.cmd bootstrap --node --yes` | 选择或准备 Node，并发布供所有仓库共用的 Node 启动器 |
| `gidd.cmd bootstrap --reinstall --yes` | 重新下载受管 Bun，验证后替换并发布；可追加 --node 改为 Node |

不带 --yes 不联网、不安装、不写配置、不创建目录或启动器。即使 PATH 已有兼容工具，首次生成启动器仍须 --yes。已有启动器与本次选择一致时返回 ready；无候选、启动器缺失或不一致时返回 needs_bootstrap。检查只说明本次实际执行的范围，不代表完整 doctor、GitHub 登录或仓库启用。

## 选择与兼容性

bootstrap 的固定顺序是受管 Bun、受管 Node、PATH Bun、PATH Node；每个来源内找到兼容候选立即停止，不为了 Bun 偏好额外下载。--node 将候选限制为 Node。无候选且有 --yes 时默认下载稳定 Bun；--node 下载 Node LTS。--reinstall 显式跳过健康复用，为选定种类准备新的受管副本，不修改外部 PATH 安装。

受管文件先验证 install.json 的文件集合、长度和 SHA-256，再执行 scripts/runtime-compat.mjs。经 PATH 再次发现同一受管路径也不能绕过完整性校验。兼容规则集中在该独立 JS 方法；PowerShell 只读取它的结果，不维护另一套最低版本。检查脚本无法执行、超时或结果不兼容时继续其他候选。兼容检查不依赖完整业务模块。

配置不提供运行时优先项、最低版本、固定版本或 bin 路径。tools.bun/node 仅有 source；稳定 Bun 与 Node LTS 是内部下载策略，实际版本与来源仍记入 install.json。gh 的 version/source 配置独立保留。旧 [bootstrap]、tools.bun.version、tools.node.version 报 config_retired_field；升级时移除这些字段，保留其他配置与注释。完整配置规则见 [configuration.md](configuration.md)。

## 普通启动

```text
gidd.cmd bootstrap → PowerShell → 检查/准备 → 发布 js_exec.cmd
gidd.cmd 其他命令 → js_exec.cmd → 选定运行时 → 当前技能的 scripts/gidd.mjs
```

工具目录永久固定为当前用户的 ~/.agents/skills.tools/gidd/，不提供覆盖。js_exec.cmd 是该目录中的生成安装数据，不提交到源码，也不是技能。它只绑定一个运行时，不包含仓库或技能路径；由调用入口提供脚本路径。受管 executable 相对启动器定位，PATH 工具使用已解析的绝对路径。普通启动不解析 TOML、不调用 PowerShell、不搜索候选、不执行兼容检查、不下载或自动回退。

启动器不存在时入口输出 gidd.cli/v1、reason=bootstrap_required、退出 2，提示 bootstrap --yes。绑定的 executable 后来被外部移除或损坏时，执行可能直接失败；重新 bootstrap 恢复，不自动换运行时重跑业务。原始参数、工作目录、stdin/stdout/stderr 和退出码直接透传；Windows 使用批处理尾转发避免 CALL 的二次参数展开。读取 UTF-8 外部路径期间临时切换并恢复控制台代码页。

兼容性只在 bootstrap（及开发测试）验证。技能升级后应先重新 bootstrap；安装/修复/切换运行时也重新验证。生成时通过不等于以后每次执行前重新校验。js_exec.cmd 是用户级共享选择，--node 发布会影响使用此目录的全部仓库；双运行时测试使用 dev.cmd bun/node，不必切换共享启动器。

## 发布、修复与恢复

--yes 在共享 .cache/install.lock 锁内重新选择，防止并发 bootstrap 或 JS 安装相互覆盖。即使只复用 PATH，也可以建立共享目录及 INSTALLATION.md 来保存启动器。健康安装复用；启动器文本相同则不重写。新文本先写唯一临时文件并刷盘，再原子替换 js_exec.cmd。失败保留已有启动器。

无合格候选时，默认目标存在且可确认属于 GIDD，则重新准备；发现其他合格候选时仍优先复用它。需要指定修复受管 Bun/Node 可用 --reinstall --yes。GIDD 归属要求 install.json 的结构可读且有效、实际目录无额外文件/子目录或链接；文件内容可以损坏或缺失。缺少/损坏安装记录、未知占用或额外用户文件一律保留并报错。

先在 .cache/<name>/payload 完成下载、官方 SHA-256、受控解压、版本与兼容检查，再把旧目录移动到 .cache/previous-<name>，发布新目录及启动器。失败时恢复旧目录；启动器发布成功后才清理备份。强制中断留下的备份由下次 bootstrap --yes 在锁内判断：已发布则重试清理，未发布则恢复后重新检查；只读 bootstrap 不执行恢复。未知备份或恢复目标损坏时保留并报告冲突。Windows 文件占用可能使替换失败，不能承诺正在使用的运行时都能热替换。

启动器发布是提交点；之后的缓存清理失败以 cleanup_pending=true 报告，不回滚已发布安装。下次 bootstrap --yes 恢复前先检查新目录的完整性及现有启动器文本；若启动器已是绑定该受管运行时的预期文本（包括修复时复用原有绑定），只重试清理备份，离线也可复用新副本。清理再次失败则停止本次操作，保留新副本和备份，避免后续安装或切换覆盖提交证据。只读 bootstrap 不执行清理。旧备份清理前先更名为 .cache/retired-<name>-<UUID>，避免部分清理的目录被当作可恢复备份；被运行进程占用的残留可在退出后清理。

JS setup bun/node/gh 仍只准备指定工具，不发布或切换 js_exec.cmd；已有目录损坏或 gh 固定版本冲突仍保留并报错。运行时存在 previous-<name> 恢复备份时，安装器在下载前报 pending_runtime_recovery，先执行 bootstrap --yes 恢复。完整安装和共享锁规则见 [setup.md](setup.md)。

## 输出与验收

bootstrap stdout 为 gidd.bootstrap/v1：ready 退出 0，needs_bootstrap 退出 1，参数/配置/安装错误退出 2。结果包含 read_only、runtime、attempts 与 launcher；写入成功包含 launcher_action、runtime_action。stderr 用于进度与错误。普通命令保持各自 JS 协议。

测试覆盖固定来源顺序、Node 选择、只读不写、旧字段拒绝、真实 Node/Bun 兼容方法、启动器共享与参数转发、普通命令不调用 PowerShell/兼容方法、失败不回退重跑、损坏安装修复、下载/发布失败回滚、未知文件保留、安装锁及中断恢复。官方归档验证使用隔离家目录，不触碰真实工具或凭据。
