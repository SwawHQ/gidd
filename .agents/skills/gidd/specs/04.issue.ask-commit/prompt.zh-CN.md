---
description:
  - issue: required
  - branch_pr: optional
  - stage_commit_push: ask
  - merge_and_related_failures: auto
  - close_issue: auto
  - other_steps: auto
issue_template: ../../references/issue.zh-CN.json
---

# 04.issue.ask-commit

## 约定
使用本仓库的 gidd.link .git、gidd.link .gh 操作 Git 和 GitHub。
自动处置或可自动继续：表示无需询问用户授权，自行依情况判断、处理和继续。
目标分支：用户未明确指定时，为仓库远端默认分支。
允许用户一次性给予持续授权，避免反复询问，但应遵守授权范围。
用户明确要求及授意的，优先；正常汇报进展与结果。

## 明确目标
开发前，务必把任务目标、修订范围明确澄清；必要时多询问人类用户。

## 确认 Issue
提倡‘小步快跑’，大的任务目标，应拆解、规划为基于多个 Issue 来分步实施。
当前规范：需要的 Issue 必须确认已存在，缺失时，必须新建。
Issue 内容需严格符合模板，模板通过 @gidd.link spec.issue.current@ 打印。
任务的拆解和 Issue 的关联，是核心重点，后续流程皆依此展开。

## 开发
围绕某一个 Issue 展开一次开发行动，目标 Issue 未明确或不存在，拒绝行动。
当前规范：允许用目标分支开发（除非用户要求拉独立分支或走 PR）。
留意：仓库当前是否目标分支、记录是否过期、用户或并行任务可能插入了改动。
若发现要修补或新建关联 Issue，应作为明确事项处理，默认自动处置。

## 验收交付
围绕某个 Issue 的行动完成时，优先以隔离上下文的方式，核对 Issue、执行 review 和测试...完善后才能交付。
一批交付只围绕某一个 Issue。

## commit
当前规范：不自动执行 git add|commit|push， 需询问用户是否提交（除非已有明确授意，默认包含 push）。
注意划分批次，避免大而混杂；而跨 Issue 的更是必须分开。
默认使用 Refs #NNN 关联 Issue。

## 合并
当前规范：若使用了独立分支或 PR 流程，push 后满足验收及仓库合并要求时，可自动继续——执行合并。
仓库Action/规范可能不通过、目标分支未收到交付等，处理前是否询问授权——自行按情况处置。
默认使用 Refs #NNN 关联 Issue。

## Issue 关闭
Issue 范围及验收条件已全部完成、远端目标分支确已收到交付，可自动处置——关闭关联的 Issue。


## 清理
留意用户及并行任务的修改，按实际情况，清理可清理的分支、同步目标分支。
