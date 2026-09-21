---
description:
  - issue: user_decides
  - branch_pr: user_decides
  - stage_commit_push: user_decides
  - merge_and_related_failures: user_decides
  - close_issue: user_decides
  - other_steps: user_decides
issue_template: ../../references/issue.zh-CN.json
---

# 01.all.ask

## 约定
使用本仓库的 gidd.link .git、gidd.link .gh 操作 Git 和 GitHub。
不自动处置：表示尚未获得授意时，如何行动-需报告并询问用户的意向和授权；用户可以一次性给予多次或持续授权（避免反复询问，但注意遵守授权的范围）。
各阶段是否适用及何时执行，由用户明确；在已有明确授权的范围内继续执行。
提交、推送、合并等操作若会自动关闭 Issue，需一并取得关闭授权，否则解除自动关闭。
参考经验供自行取舍。


## 明确目标
把任务目标、修订范围明确澄清，必要时多询问用户。

## 确认 Issue
是否关联/建立 Issue，不自动处置。
若要建立，参考经验：①提倡‘小步快跑’，把任务目标，拆解、规划为基于多个 Issue 来分步实施。②需要的 Issue 缺失时，应新建。③Issue 内容需严格符合模板，模板通过 @gidd.link spec.issue.current@ 打印。

## 开发
确认目标和改动范围已明确，否则继续询问用户。
确定目标分支、是否使用独立分支和 PR：不自动处置。
参考经验：①留意：仓库当前是否目标分支、记录是否过期、用户或并行任务可能插入了改动。②若关联/使用了 Issue：围绕某一个 Issue 展开一次开发行动，若发现要修补或新建关联 Issue，应作为明确事项处理，不要忽视。

## 验收交付
review、测试等验收动作，不自动处置。
参考经验：①核对目标及验收条件，优先以隔离上下文的方式执行 review 和测试，完善后再交付。②若关联或使用了 Issue，同时核对其范围和完成情况，并建议一批交付只围绕某一个 Issue。

## commit
暂存及提交，不自动处置。
参考经验：①注意划分批次，避免大而混杂，而跨 Issue 的更应该分开。②若应用了 Issue，默认使用 Refs #NNN 关联。

## push
当前规范：不自动处置。

## 合并
当前规范：不自动处置。
若使用了分支、PR 流程，参考经验：①留意仓库Action/规范可能不通过、目标分支是否确已收到交付...②若应用了 Issue，默认使用 Refs #NNN 关联。

## Issue 关闭
当前规范：不自动处置(若确实关联/使用了 Issue)。
参考经验：留意 Issue 范围确已处理、目标分支确已收到交付。

## 清理
当前规范：不自动处置。
参考经验：留意用户及并行任务的修改，按实际情况，清理可清理的分支/临时文件等，同步目标分支。
