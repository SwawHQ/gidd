基于 Git Worktree、GitHub Issue 为要求可审计（过程留痕）、外包式（先立验收契约再开发）、多任务并行、流水线式协作的开发，提供任务登记、工作区分配管理与交付等工具。

## GIDD 会要求 Agent 遵守以下流程规范

① 任务开始前，必须通过 Issue 登记需求和验收契约

② 目标变更或进展更新，也必须先在 Issue 上做登记或追评

③ 让你指定或为你推荐交付模式

单 Agent 交付模式：
```
直接提交
新建工作分支和 worktree 开发后本地合并
新建工作分支和 worktree 开发后走 PR 合并
```

多 Agent（正在完善中）协作交付模式：
```
需求提出者：只提出问题或需求，建立 issue，以及收到 Issue 评论时，决定是否修订 issue
任务猎人：扫描领取 issue ，执行开发或修复后创建 PR
审查验收者：扫描领取已处理的 issue，执行审查：验收 PR 后关闭 issue，或追评后退回重修
```

④ 让你指定或为你推荐授权方案

Agent 接受在下面任何一个或多个环节前暂停，等你授意后，再继续（交付模式若不包含的则自然不适用）：
```
开始开发
内部验收
git add
git commit
git merge
merge 报错
git push
push 报错
pr merge
pr merge 报错
pr merge 后同步本地目标分支
同步本地目标分支出错
关闭 issue
执行清理（为下一轮任务准备）
```


## 特性

① 自带 git、gh（GitHub CLI）、bun/node 准备：会优先沿用系统已存在的，缺少时自动下载/设置便携版；放置于：~/.agents/skills.tools/gidd/

② 也可用于 Git/GitHub 操作，如 clone、Issue、PR 等。

③ 对 Issue 任务的领取情况、任务专用工作分支的 worktree 会放置于 <目标仓库>.gidd/ 中（没有时会新建）。

④ 会沿用 git 命令原生的配置，只是若存在 for.swaw.gidd 的 git remote 时候优先使用。

⑤ gh 授权账号需按仓库指定：当一个仓库目录启用 GIDD 时，Agent 会提示让你做一次账号登录与授权。



## 安装

```
npx skills add github.com/swawhq/gidd
```
或使用 gh:
```
gh skills install github.com/swawhq/gidd
```

## 详细帮助

- [命令与参数](references/gidd.help.zh-CN.md)：任务、交付和工具命令。
- [工具准备参数](references/tools.ensure.help.zh-CN.md)：准备、检查和修复工具。
- [本地数据目录](references/data.md)：任务记录、工作树、恢复与清理。
- [卸载与清理](references/disable.md)：技能、共享工具和本地数据的移除说明。
