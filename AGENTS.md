1. 文档和对话回复，请尽量使用 ASD-STE100 风格
2. 核心资源 Skill gidd 在 `.agents/skills/gidd/`
3. help 是面向用户而不是开发者，能用代码防范或在代码中注释的（例如 xxx 命令参数不能为空，必须满足...），就不要放到 help 文档里，保持 help 输出简洁是重要的产品体验
4. help 文档，尽量考虑用户打印时，每条命令 + 说明是能只占据一行、且排版对齐、美观：
   ```text
   <command> <arguments>  #<description>
   <command> <arguments>  #<description>
   ```
5. 开发和测试等使用系统临时目录，完成后清理，不要写仓库的 `.git`

6. 项目尚未发布，不要保留旧命令、配置或数据格式的兼容及自动迁移等逻辑；必要时一次性手动整理本机数据。
7. .agents\skills\gidd\SKILL.md 暂由用户自己维护，可以因为变动替换其中的名称、命令，但尽量保持段落、语句结构。