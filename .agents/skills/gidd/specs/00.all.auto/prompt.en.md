---
description:
  - issue: agent_decides
  - branch_pr: agent_decides
  - stage_commit_push: agent_decides
  - merge_and_related_failures: agent_decides
  - close_issue: agent_decides
  - other_steps: agent_decides
issue_template: ../../references/issue.en.json
---

# 00.all.auto

## Conventions
Use this repository's gidd.link .git and gidd.link .gh for Git and GitHub operations.
Autonomous handling means you may proceed without asking the user for authorization; use your judgment to decide how to act, handle the situation and continue.
Practical guidance is optional; use it at your discretion.
Independently decide whether and when each step applies, and report progress and results as usual; explicit user requirements take precedence.

## Clarify the goal
Current policy: autonomous handling.
Practical guidance: clarify the task goal and scope of changes, asking the user when needed.

## Establish the Issue
This spec does not require creating an Issue; use autonomous handling.

If creating Issues, practical guidance: (1) Favor small increments; break down and plan the task goal across multiple Issues for implementation in stages. (2) Create any needed Issues that are missing. (3) Issue contents must strictly follow the template, printed by @gidd.link spec.issue.current@.

## Development
Current policy: autonomous handling.
Practical guidance: (1) Check whether the repository is on the target branch, whether records are stale, and whether the user or concurrent tasks may have introduced changes. (2) If an Issue is linked or used, focus each development effort on one Issue. If a related Issue needs revision or creation, address it explicitly rather than overlooking it.

## Acceptance and delivery
Current policy: autonomous handling.
Practical guidance: (1) Check the goal and acceptance criteria, preferably perform review and testing in an isolated context, and address findings before delivery. (2) If an Issue is linked or used, also check its scope and completion status; keeping each delivery batch focused on one Issue is recommended.

## commit
Current policy: autonomous handling.
Practical guidance: split changes into batches to avoid large, mixed commits; changes spanning multiple Issues should especially be kept separate.

## push
Current policy: autonomous handling.

## Merge
Current policy: autonomous handling.
If using a branch or PR workflow, practical guidance: watch for failing repository Actions or unmet requirements, and check whether the target branch has actually received the delivery.

## Close the Issue
Current policy: autonomous handling (if an Issue is actually linked or used).
Practical guidance: check that the Issue's scope has been addressed and the target branch has actually received the delivery.

## Cleanup
Current policy: autonomous handling.
Practical guidance: account for changes made by the user and concurrent tasks; clean up eligible branches, temporary files and similar items, and synchronize the target branch as appropriate.
