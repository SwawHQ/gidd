1. 针对仓库停用本技能，删除 `<目标仓库根>/.agents/skills/gidd/gidd.link.cmd` 即可（后续仍可能触发是否启用 GIDD）
2. 技能按仓库安装的，删除 `<目标仓库根>/.agents/skills/gidd/` 即可
3. 完整卸载（所有仓库不再使用本技能）应包含：技能安装目录、`<仓库根>/.agents/skills/gidd/` 和共享工具目录 `~/.agents/skills.tools/gidd/`
