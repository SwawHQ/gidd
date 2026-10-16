import { existsSync } from 'node:fs';
import { runTool, toolNames } from './commands/tool/index.mjs';
import { isAbsolute, resolve } from 'node:path';
import { configurationHint } from './shared/config.mjs';
import { doctor, parseDoctorArguments } from './commands/doctor/index.mjs';
import { parsePolicyArguments, runPolicy, policyError } from './commands/policy/index.mjs';
import { printHelp } from './commands/help.mjs';
import { parseLangArguments, langCommand } from './commands/lang/index.mjs';
import { show } from './commands/set/show.mjs';
import { parseWorktreeArguments, runWorktree } from './commands/worktree/index.mjs';
import { parseGhArguments, runGh } from './commands/gh/index.mjs';
import { parseIssueArguments, runIssue } from './commands/issue/index.mjs';
import { parseIssueTaskArguments, runIssueTask } from './commands/issue-task/index.mjs';
import { workspaceReport } from './shared/workspace-report.mjs';
import { diagnosticReport } from './shared/diagnostics.mjs';
import { currentRepository } from './shared/current-repository.mjs';

// Keep validation order, output channels and exit codes at the CLI boundary.
export async function main(args, { boundRepository } = {}) {
  const route = (args.shift() || 'help').toLowerCase();
  if (toolNames.includes(route)) return runTool(route, args);
  const command = route.startsWith('policy.') ? 'policy'
    : route.startsWith('worktree.') ? 'worktree'
    : route.startsWith('gh.') ? 'gh'
    : route.startsWith('lang.') ? 'lang'
    : /^[0-9]+(?:\.|$)/.test(route) ? 'issue-task' : route;
  const repositoryCommand = ['gh', 'issue', 'issue-task'].includes(command);
  const policyOutput = command === 'policy' || command === 'issue-task' && route.endsWith('.policy');
  const configurationCommand = ['set.show', 'lang'].includes(command);
  const schemas = { 'set.show': 'gidd.config/v1', lang: 'gidd.config/v1', doctor: 'gidd.doctor/v1', policy: 'gidd.policy/v1', worktree: 'gidd.worktree/v1', gh: 'gidd.task-command/v1', issue: 'gidd.task-command/v1', 'issue-task': 'gidd.task-command/v1' };
  let schema = 'gidd.cli/v1';
  try {
    if (['help','--help','-h'].includes(command)) {
      if (args.length > 1) throw new Error('invalid_arguments');
      printHelp(args[0], boundRepository); return 0;
    }
    if (!Object.hasOwn(schemas,command)) throw new Error('unknown_command');
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('unsupported_platform');
    let policyOptions, worktreeOptions, commandOptions;
    if (repositoryCommand) {
      schema = schemas[command];
      commandOptions = command === 'gh' ? parseGhArguments(route, args) : command === 'issue'
        ? parseIssueArguments(route, args) : parseIssueTaskArguments(route, args);
      args = [];
    }
    if (command === 'lang') {
      schema = schemas.lang;
      commandOptions = parseLangArguments(route, args);
      args = [];
    }
    if (command === 'worktree') {
      schema = schemas.worktree;
      worktreeOptions = parseWorktreeArguments(route, args);
      args = [];
    }
    if (command === 'policy') {
      schema = schemas.policy;
      policyOptions = parsePolicyArguments(route, args);
      args = [];
    }
    let doctorOptions;
    if (command === 'doctor') {
      doctorOptions = parseDoctorArguments(args);
      args = [];
    }
    if (args.length) throw new Error('invalid_arguments');
    const needsRepository = !configurationCommand && command !== 'doctor' &&
      (command !== 'policy' || policyOptions.action === 'history');
    const repository = needsRepository ? boundRepository || await currentRepository()
      : command === 'doctor' ? boundRepository || process.cwd() : undefined;
    if (repository && !isAbsolute(repository)) throw new Error('repository_must_be_absolute');
    if (needsRepository && !existsSync(resolve(repository, '.git'))) throw new Error('not_git_repository_root');
    schema = schemas[command];
    if (command === 'policy') return await runPolicy(repository, policyOptions);
    if (command === 'issue-task' && commandOptions.action === 'policy') return await runIssueTask(repository, commandOptions);
    let report;
    if (command === 'doctor') report = await doctor(repository, { ...doctorOptions, fixedRepository: !!boundRepository });
    else if (command === 'worktree') report = await runWorktree(repository, worktreeOptions);
    else if (command === 'gh') report = await runGh(repository, commandOptions);
    else if (command === 'issue') report = await runIssue(repository, commandOptions);
    else if (command === 'issue-task') report = await runIssueTask(repository, commandOptions);
    else if (command === 'lang') report = langCommand(repository, commandOptions);
    else if (command === 'set.show') report = show(repository);
    if (command === 'set.show') process.stdout.write(report.content);
    else console.log(JSON.stringify(repositoryCommand || command === 'worktree' ? workspaceReport(report) : report));
    // Explicit omissions and blocked local checks cannot establish readiness.
    // Preserve the existing zero exit for otherwise healthy, partial online probes.
    if (command === 'doctor' && report.checks?.some(item => item.status === 'not_checked' &&
      (!item.id.endsWith('..online') || ['disabled', 'not_declared'].includes(item.details?.code)))) return 1;
    return ['ready','local_ready','checks_passed','checks_incomplete'].includes(report.status) ? 0 : 1;
  } catch (error) {
    const reason = /^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$/.test(error.message) ? error.message : 'operation_failed';
    if (policyOutput) {
      console.log(JSON.stringify(policyError(boundRepository, undefined, reason), null, 2));
      return 2;
    }
    const bindingHint = reason.startsWith('tool_binding') ? 'Run tools.ensure.cmd to prepare shared tools and rebuild bindings.' : '';
    const hint = configurationHint(reason);
    if (bindingHint) console.error(bindingHint);
    if (hint) console.error(hint);
    const worktreeHints = {
      task_required: 'Register and prepare the Issue with gidd <Issue编号> --policy <policy>.',
      task_policy_required: 'Choose a policy with the user, then supply --policy <policy> when creating or first registering the Issue.',
      task_policy_changed: 'Read the saved approval points with gidd <Issue编号>.policy; use <Issue编号>.policy.set <policy> to change them.',
      task_policy_mode_locked: 'Preparation has started. Keep its delivery mode, or abort preparation or finish and clean the task before changing modes.',
      task_registration_pending: 'Registration is incomplete. Repeat gidd <Issue编号> --policy <policy> before changing its policy.',
      account_token_unavailable: 'Run gidd gh.auth to authorize the delivery account for this repository.',
      gh_auth_required: 'Run gidd gh.auth to choose and authorize the delivery account for this repository.',
      gh_login_failed: 'GitHub login did not complete. Retry gidd gh.auth when ready.',
      unexpected_account: 'The current credentials belong to a different account from the task record. Use the recorded account credentials before retrying.',
      issue_ambiguous: 'Multiple workspace records match this Issue. Inspect local records before continuing.',
      task_workspace_changed: 'The task and workspace records disagree. Inspect local records before continuing.',
      issue_creation_unconfirmed: 'Issue creation was not confirmed. Inspect GitHub before creating again; continue a confirmed Issue with gidd <Issue编号> --policy <policy>.',
      issue_creation_pending: 'An unfinished creation request is recorded. Repeat its original command, or inspect create-pending.json and resolve that request first.',
      issue_copy_required: 'The local Issue copy is missing. Repeat gidd <Issue编号> --policy <policy> to complete registration.',
      worktree_preparation_pending: 'Preparation is incomplete. Repeat gidd <Issue编号> --policy <policy>, or run gidd <Issue编号>.cleanup to abort preparation.',
      issue_draft_missing: 'The file supplied with --file does not exist. Relative paths are resolved from the calling directory.',
      issue_draft_invalid: 'Supply a UTF-8 Markdown file whose first nonblank line is # Title.',
      issue_title_empty: 'Write an Issue title after # in the file supplied with --file. The [gidd] prefix alone is not a title.',
      delivery_context_exists: 'A direct-commit delivery record already exists. Inspect gidd <Issue编号>; resume with gidd <Issue编号> --policy <policy>. After delivery, run gidd <Issue编号>.cleanup before starting a new task.',
      issue_registered: 'This Issue number already has a local task record. Inspect it with gidd <Issue编号>; the existing record is retained.',
      delivery_target_branch_required: 'Check out the intended target branch in the target repository, then prepare the workspace again.',
      delivery_target_ahead: 'The local target branch is ahead of its remote counterpart. Inspect unpublished commits or a remote history rewrite, resolve the difference, then retry workspace preparation. Nothing was pushed or reset.',
      delivery_target_diverged: 'Local and remote target histories have diverged. Resolve the target branch history before preparing a new workspace; local changes are retained.',
      delivery_target_dirty: 'The target checkout has uncommitted changes. Preserve or finish them before retrying the target update.',
      delivery_target_busy: 'The target checkout has an unfinished Git operation or a Git lock. Resolve it before retrying the target update.',
      delivery_target_index_flags: 'The target index hides tracked changes. Inspect assume-unchanged or skip-worktree flags before retrying the target update.',
      delivery_target_changed: 'The target branch changed during this command. Inspect the current branches and workspace records before retrying.',
      delivery_merge_changed: 'The saved squash plan differs from the current branches or arguments. Inspect the target checkout and saved plan, and resolve the difference with Git before continuing.',
      delivery_merge_unconfirmed: 'The local merge result is not confirmed. Inspect the target checkout, commit history and saved squash plan before continuing.',
      workspace_branch_changed: 'The checkout differs from the recorded working branch. Inspect the expected and actual branches, restore the working branch, then retry.',
      worktree_branch_mismatch: 'The checkout differs from the recorded working branch. Inspect the expected and actual branches before retrying.',
      delivery_context_required: 'No local workspace is recorded for this Issue. Inspect worktree.list, then prepare it with gidd <Issue编号> --policy <policy>.',
      delivery_target_checkout_required: 'Check out the recorded target branch in its intended directory, then retry <Issue编号>.merge.',
      pr_head_changed: 'The PR head differs from the local working branch commit. Inspect and synchronize the intended changes before retrying.',
      pr_merge_pending: 'The PR is not confirmed merged. Inspect its checks, branch rules or queue before retrying; retain the workspace.',
      delivery_target_not_synced: 'Run gidd <Issue编号>.target-sync before closing the Issue.',
      issue_link_failed: 'GitHub rejected the Development association. Inspect permissions and API availability, then retry <Issue编号>.close-issue.',
      issue_link_unconfirmed: 'The Development association is not confirmed. Inspect the Issue and retry <Issue编号>.close-issue; resources are retained.',
      issue_links_incomplete: 'The Issue has more PR associations than this command can inspect. Inspect its Development links before retrying.',
      issue_not_completed: 'The Issue was closed as not planned. Confirm how it should be resolved before retrying.',
      issue_close_unconfirmed: 'Issue closure is not confirmed. Inspect its state and retry <Issue编号>.close-issue; resources are retained.',
      worktree_branch_exists: 'The generated working branch already exists. Inspect it and worktree.list; continue its recorded task or resolve the existing branch before preparing this Issue again.',
      delivery_remote_branch_exists: 'The generated working branch already exists on the working remote. Inspect that branch before preparing this Issue again.',
      workspace_released: 'This dedicated worktree has already been released. Start a new task for a new Issue; its directory may be reused.',
      worktree_not_released: 'This directory has not been released. After delivery, run gidd <Issue编号>.cleanup before gidd worktree.remove <path>.',
      worktree_state_changed: 'The Git checkout no longer matches its verified state. Inspect the registered directory before retrying.',
      worktree_target_repository_protected: 'The target repository checkout cannot be removed by worktree.remove. Use <Issue编号>.cleanup after delivery.',
      worktree_unknown_selector: command === 'worktree'
        ? 'No GIDD worktree is registered at this directory. Use gidd worktree.list to find its path.'
        : 'No GIDD workspace record matches this Issue. Use gidd worktree.list to inspect registered workspaces.',
      worktree_pr_not_found: 'No merged PR matches the recorded repository, branches and working branch commit. Resources are retained; inspect delivery before retrying.',
      worktree_pr_ambiguous: 'Multiple merged PRs match this working branch and commit. Resources are retained; inspect the conflicting delivery records.',
      worktree_pr_discovery_incomplete: 'PR discovery could not inspect the complete matching history. Resources are retained; inspect delivery before retrying.'
    };
    const errorFields = { schema, status: 'error', reason,
      ...(error.dataReport ? { details: error.dataReport } : {}),
      ...(error.details ? { details: error.details } : {}),
      ...(repositoryCommand && error.workspace ? error.workspace : {}),
      ...((command === 'worktree' || repositoryCommand) && worktreeHints[reason] ? { hint: worktreeHints[reason] } : {}) };
    const errorReport = JSON.stringify(repositoryCommand || command === 'worktree' ? workspaceReport(errorFields) : diagnosticReport(errorFields));
    if (command === 'set.show') console.error(errorReport);
    else console.log(errorReport);
    return 2;
  }
}
