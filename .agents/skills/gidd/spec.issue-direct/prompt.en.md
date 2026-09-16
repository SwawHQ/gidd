# Issue + direct delivery

## 1. Identify the Issue

Identify the associated Issue before changing files and read its goal, scope and acceptance criteria.
Read the form returned by gidd.link spec.issue-direct.issue and follow its field order, labels, required fields and descriptions when creating or updating the Issue.
Organize the body using the form labels as Markdown headings. Fill in actual task details and verifiable acceptance criteria as checkbox items; replace prefilled examples and leave no placeholders.
Reuse an existing Issue.
If a new one is needed, complete the Issue template before creating it; do not create duplicates for the same task.

## 2. Confirm the target branch

Confirm that delivery targets this repository's default branch.
Commits on that branch are allowed; a development branch, PR and independent approval are not required.
The local default-branch record may be stale.
Query GitHub when uncertain; do not assume main or treat the current branch as the default.

## 3. Implement and validate

Implement the Issue's scope while preserving the user's existing changes.
Use this repository's gidd.link .git / .gh for Git and GitHub commands with the configured defaults; explicit arguments retain native override semantics.
Review each acceptance criterion, run relevant tests, and record passing, failing and unverified items.
Review the Issue yourself for completeness, consistency with its form and changes in scope; update it when needed.

## 4. Commit and push

Commit and push within the user's authorized scope, linking commits to the Issue (for example Refs #123).
Check the branch, working tree and latest remote state first.
Respect existing remote protections; investigate rejected pushes without force-pushing or bypassing rules.
If the user says not to commit or push, stop before that step.

## 5. Record delivery

After delivery, record remote commit identifiers, validation and remaining work on the Issue.
Close it only when the target branch has received the changes and every acceptance criterion is satisfied.
A local commit alone is not delivery.
Keep partially completed Issues open and avoid premature Closes/Fixes keywords.

## Notes

This command only reads configuration and provides guidance.
It does not commit, push, write Issues, authorize accounts or install remote rules, and does not verify remote permissions.
Follow doctor guidance before remote operations.
Perform writes only when the current task authorizes those operations.
Native Git/gh commands do not enforce this spec for you.
