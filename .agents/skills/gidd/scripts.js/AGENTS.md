## 维护 gidd.cmd doctor 命令需要注意

其打印信息明确规范化，每项诊断都有明确 ID，并且使用了前缀分类：

1. `tool.` 开头的 ID：工具类的实际状态
2. `folder.`：（仓库）本地目录的各种实际状态
3. `config.toml`：config.toml 文件本身的实际状态
4. `config.`：config.toml 中具体字段的实际状态

ID 后有 `..online`，表示会联网检查的实际状态（默认不要求联网）

`references/doctor.toml` 通过上述 ID 声明开关和诊断提示；模块映射保留在 doctor 的注册表。
诊断文本使用成对的 `.en` / `.zh-CN` 字段，占位符保持一致；命令参数、检查 ID、状态和错误代码不翻译。
禁用或未声明的检查不得由依赖间接执行；新增检查时同时维护模块注册和 TOML 声明。

## 命令模块

`commands/gh/` 处理 `gidd gh.*`；`commands/issue/` 处理 `gidd issue`；`commands/issue-task/` 处理 `gidd <Issue编号>` 及其子命令，包括 `.flow` 和 `.flow.set`。各模块维护自己的参数解析和执行入口，入口文件只分流命令。共用的仓库检查和任务登记检查放在 `shared/`，不通过另一个命令入口调用。
