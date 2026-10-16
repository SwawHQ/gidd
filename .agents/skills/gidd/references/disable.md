不再为某仓库使用 GIDD 时，停止调用 GIDD 命令即可。

若执行过 `gidd gh.auth.git`，卸载共享工具前，在该仓库执行 `gidd git config --local --unset-all credential.https://github.com.helper`。其他 GitHub 主机需替换命令中的 `github.com`。这会删除该主机的全部仓库级凭据助手，保留 gh 登录和提交署名；不会恢复此前被替换的仓库配置。

卸载技能时，删除对应的技能安装目录。所有仓库都不再使用共享工具时，可另行删除 `~/.agents/skills.tools/gidd/`；其中也保存用户级语言偏好。

删除技能前先处理仍需继续的任务及专用 worktree；`<目标仓库>.gidd` 本地数据目录不会随技能卸载自动删除。资源清理方式见本地数据目录内的 `README.md`，检查及维护见 [本地数据目录](data.md)。
