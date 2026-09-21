---
description:
  - issue: required
  - branch_pr: required
  - stage_commit_push: ask
  - merge_and_related_failures: auto
  - close_issue: ask
  - other_steps: auto
issue_template: ../_share/issue.zh-CN.json
---

# 09.issue.pr.ask-commit.ask-close

## 约定
使用本仓库的 gidd.link .git、gidd.link .gh 操作 Git 和 GitHub。
自动处置：表示可以不询问用户授权，如何行动-你自行依情况判断、处理和继续。
目标分支：用户未明确指定时，为仓库远端默认分支。
用户明确要求及授意的，优先；正常汇报进展与结果。

## 明确目标
把任务目标、修订范围明确澄清，必要时多询问用户。

## 确认 Issue
提倡‘小步快跑’，大的任务目标，应拆解、规划为基于多个 Issue 来分步实施。
当前规范：需要的 Issue 必须确认已存在，缺失时，必须新建。
Issue 内容需严格符合模板，模板通过 @gidd.link spec.issue.current@ 打印。
任务的拆解和 Issue 的关联，是核心重点，后续流程皆依此展开。

## 开发
围绕某一个 Issue 展开一次开发行动，目标 Issue 未明确或不存在，拒绝行动。
当前规范：必须在专用开发分支上实施，并通过 PR 合并到目标分支。
留意：明确目标分支、仓库当前记录是否过期、用户或并行任务可能插入了改动。
若发现要修补或新建关联 Issue，应作为明确事项处理，默认自动处置。

## 验收交付
围绕某个 Issue 的行动完成时，优先以隔离上下文的方式，核对 Issue、执行 review 和测试...完善后才能交付。
一批交付只围绕某一个 Issue。

## commit
当前规范：不自动执行 git add|commit|push， 需询问用户是否提交（除非已有明确授意，默认包含 push）——会自动关闭 Issue 的，还需一并取得用户授权，否则解除自动关闭。
注意划分批次，避免大而混杂；而跨 Issue 的更是必须分开。
默认使用 Refs #NNN 关联 Issue。

## 合并
推送开发分支后，创建或更新指向目标分支的 PR。
当前规范：满足验收及仓库合并要求后，可自动处置，合并该 PR——但若会自动关闭 Issue 的，应取得用户授权，否则解除自动关闭。
仓库Action/规范可能不通过、目标分支未收到交付等，处理前是否询问授权——自行按情况处置。
默认使用 Refs #NNN 关联 Issue。

## Issue 关闭
确认 Issue 范围及验收条件全部完成、远端目标分支确已收到交付后，报告结果，然后需询问用户是否关闭（除非已有明确授意）

## 清理
留意用户及并行任务的修改，按实际情况，自动处置：清理可清理的分支、同步目标分支。