---
description: "The user specifies whether and when each step applies; the Agent does not act autonomously (but may report, ask questions and assist)."
issue_template: ../_share/issue.en.json
---

# 01.all.ask

## Conventions
Use this repository's gidd.link .git and gidd.link .gh for Git and GitHub operations.
No autonomous handling means that, until the user has given direction, you must report the situation and ask for their intent and authorization before deciding how to act. The user may grant authorization for multiple actions or ongoing work at once to avoid repeated questions, but stay within its scope.
The user specifies whether and when each stage applies; continue within the scope of existing explicit authorization.
If committing, pushing, merging or another action would automatically close an Issue, obtain authorization for that closure as well; otherwise, remove the automatic closure association.
Practical guidance is optional; use it at your discretion.


## Clarify the goal
Clarify the task goal and scope of changes, asking the user further questions as needed.

## Establish the Issue
Whether to link or create an Issue: no autonomous handling.
If creating Issues, practical guidance: (1) Favor small increments; break down and plan the task goal across multiple Issues for implementation in stages. (2) Create any needed Issues that are missing. (3) Issue contents must strictly follow the template, printed by @gidd.link spec.issue.current@.

## Development
Confirm that the goal and scope of changes are clear; otherwise, continue asking the user.
Choosing the target branch and whether to use a separate branch and a PR: no autonomous handling.
Practical guidance: (1) Check whether the repository is on the target branch, whether records are stale, and whether the user or concurrent tasks may have introduced changes. (2) If an Issue is linked or used, focus each development effort on one Issue. If a related Issue needs revision or creation, address it explicitly rather than overlooking it.

## Acceptance and delivery
Review, testing and other acceptance activities: no autonomous handling.
Practical guidance: (1) Check the goal and acceptance criteria, preferably perform review and testing in an isolated context, and address findings before delivery. (2) If an Issue is linked or used, also check its scope and completion status; keeping each delivery batch focused on one Issue is recommended.

## commit
Staging and committing: no autonomous handling.
Practical guidance: (1) Split changes into batches to avoid large, mixed commits; changes spanning multiple Issues should especially be kept separate. (2) If an Issue is used, reference it with Refs #NNN by default.

## push
Current policy: no autonomous handling.

## Merge
Current policy: no autonomous handling.
If using a branch or PR workflow, practical guidance: (1) Watch for failing repository Actions or unmet requirements, and check whether the target branch has actually received the delivery. (2) If an Issue is used, reference it with Refs #NNN by default.

## Close the Issue
Current policy: no autonomous handling (if an Issue is actually linked or used).
Practical guidance: check that the Issue's scope has been addressed and the target branch has actually received the delivery.

## Cleanup
Current policy: no autonomous handling.
Practical guidance: account for changes made by the user and concurrent tasks; clean up eligible branches, temporary files and similar items, and synchronize the target branch as appropriate.
