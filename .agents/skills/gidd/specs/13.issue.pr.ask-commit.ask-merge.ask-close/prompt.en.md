---
description: "An Issue and a PR workflow are required. Ask before staging, committing, pushing, merging, handling related failures or closing the Issue; the Agent continues other stages automatically."
issue_template: ../_share/issue.en.json
---

# 13.issue.pr.ask-commit.ask-merge.ask-close

## Conventions
Use this repository's gidd.link .git and gidd.link .gh for Git and GitHub operations.
Autonomous handling means you may proceed without asking the user for authorization; use your judgment to decide how to act, handle the situation and continue.
Must not continue automatically means only report the results and ask the user to authorize further action, unless they have already explicitly authorized it.
Target branch: the repository's remote default branch unless the user explicitly specifies another one.
Explicit user requirements and directions take precedence; report progress and results as usual.

## Clarify the goal
Clarify the task goal and scope of changes, asking the user further questions as needed.

## Establish the Issue
Favor small increments; break down and plan large task goals across multiple Issues for implementation in stages.
Current policy: confirm that the needed Issues exist; any missing ones must be created.
Issue contents must strictly follow the template, printed by @gidd.link spec.issue.current@.
Task breakdown and Issue association are central; all subsequent work follows from them.

## Development
Focus each development effort on one Issue. Do not proceed with development if the target Issue is unclear or does not exist.
Current policy: implementation must take place on a dedicated development branch, and changes must be merged into the target branch through a PR.
Confirm the target branch, check whether the repository's current records are stale, and account for changes the user or concurrent tasks may have introduced.
If a related Issue needs revision or creation, address it explicitly; use autonomous handling by default.

## Acceptance and delivery
When work on an Issue is complete, check the Issue and perform review and testing, preferably in an isolated context. Address findings before delivery.
Each delivery batch must focus on one Issue.

## commit
Current policy: do not run git add, commit or push without authorization. Ask the user whether to commit unless they have already explicitly authorized it; committing includes pushing by default. If this would automatically close an Issue, also obtain the user's authorization for that closure; otherwise, remove the automatic closure association.
Split changes into batches to avoid large, mixed commits; changes spanning multiple Issues must be kept separate.
Reference the Issue with Refs #NNN by default.

## Merge
After pushing the development branch, create or update a PR targeting the target branch.
Current policy: once acceptance criteria and repository merge requirements are satisfied, you must not continue automatically with merging. If merging would automatically close an Issue, also obtain the user's authorization for that closure; otherwise, remove the automatic closure association.
If repository Actions fail, requirements are unmet, or the target branch ultimately has not received the delivery, you must not automatically proceed with handling these situations; report the results and ask for authorization unless the user has already explicitly authorized the action.
Reference the Issue with Refs #NNN by default.

## Close the Issue
After confirming that the Issue's entire scope and all acceptance criteria are complete and that the remote target branch has actually received the delivery, report the results, then ask the user whether to close the Issue unless they have already explicitly authorized its closure.

## Cleanup
Account for changes made by the user and concurrent tasks. As appropriate, autonomously clean up eligible branches and synchronize the target branch.
