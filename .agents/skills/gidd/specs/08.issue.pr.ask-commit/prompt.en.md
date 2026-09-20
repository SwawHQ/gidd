---
description: "An Issue and a PR workflow are required. Ask before commit/push; the Agent continues other stages automatically."
issue_template: ../_share/issue.en.json
---

# 08.issue.pr.ask-commit

## Conventions
Use this repository's gidd.link .git and gidd.link .gh for Git and GitHub operations.
Autonomous handling means you may proceed without asking the user for authorization; use your judgment to decide how to act, handle the situation and continue.
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
Current policy: do not run git add, commit or push without authorization. Ask the user whether to commit unless they have already explicitly authorized it; committing includes pushing by default.
Split changes into batches to avoid large, mixed commits; changes spanning multiple Issues must be kept separate.
Reference the Issue with Refs #NNN by default.

## Merge
After pushing the development branch, create or update a PR targeting the target branch.
Current policy: once acceptance criteria and repository merge requirements are satisfied, you may autonomously merge the PR.
Repository Actions may fail, requirements may be unmet, or the target branch may not have received the delivery. Use your judgment to decide whether to ask for authorization before addressing these situations.
Reference the Issue with Refs #NNN by default.

## Close the Issue
Once the Issue's entire scope and all acceptance criteria are complete, and the remote target branch has actually received the delivery, you may autonomously close the associated Issue.

## Cleanup
Account for changes made by the user and concurrent tasks. As appropriate, autonomously clean up eligible branches and synchronize the target branch.
