import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { configurationHint } from './shared/config.mjs';
import { doctor, parseDoctorArguments } from './commands/doctor/index.mjs';
import { auth } from './commands/gh/auth.mjs';
import { parseSpecArguments, runSpec, specError } from './commands/spec/index.mjs';
import { git } from './commands/git/index.mjs';
import { gh } from './commands/gh/index.mjs';
import { printHelp } from './commands/help.mjs';
import { set } from './commands/set/index.mjs';
import { show } from './commands/set/show.mjs';
import { clear } from './commands/clear.mjs';
import { parseWorktreeArguments, runWorktree } from './commands/worktree/index.mjs';
import { parseWorkflowArguments, runWorkflow } from './commands/workflow/index.mjs';
import { workspaceReport } from './shared/workspace-report.mjs';
import { runInit } from './commands/init.mjs';

// Keep validation order, output channels and exit codes at the CLI boundary.
export async function main(args, { boundRepository } = {}) {
  const route = (args.shift() || 'help').toLowerCase();
  const command = route.startsWith('spec.') ? 'spec' : route.startsWith('worktree.') ? 'worktree' : route.startsWith('workflow.') ? 'workflow' : route;
  const configurationCommand = ['set.show', 'set', 'clear'].includes(command);
  const schemas = { init: 'gidd.init/v1', 'set.show': 'gidd.config/v1', set: 'gidd.config/v1', clear: 'gidd.config/v1', doctor: 'gidd.doctor/v1', '.gh.auth': 'gidd.auth/v1', spec: 'gidd.spec/v1', worktree: 'gidd.worktree/v1', workflow: 'gidd.workflow/v1' };
  let schema = 'gidd.cli/v1';
  try {
    if (['help','--help','-h'].includes(command)) {
      if (args.length > 1) throw new Error('invalid_arguments');
      printHelp(args[0]); return 0;
    }
    if (command === 'set' && args.length === 0) {
      printHelp(); return 0;
    }
    if (['.gh', '.git'].includes(command)) {
      if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('unsupported_platform');
      if (!boundRepository) throw new Error('repository_binding_required');
      return await (command === '.git' ? git : gh)(boundRepository, args);
    }
    if (!Object.hasOwn(schemas,command)) throw new Error('unknown_command');
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('unsupported_platform');
    let key, value, specOptions, worktreeOptions, workflowOptions;
    if (command === 'workflow') {
      schema = schemas.workflow;
      workflowOptions = parseWorkflowArguments(route, args);
      args = [];
    }
    if (command === 'worktree') {
      schema = schemas.worktree;
      worktreeOptions = parseWorktreeArguments(route, args);
      args = [];
    }
    if (command === 'spec') {
      schema = schemas.spec;
      specOptions = parseSpecArguments(route, args);
      args = [];
    }
    if (configurationCommand) {
      if (command !== 'set.show') { key = args.shift(); if (key === undefined) throw new Error('invalid_arguments'); }
      if (command === 'set') { value = args.shift(); if (value === undefined) throw new Error('invalid_arguments'); }
    }
    let doctorOptions;
    if (command === 'doctor') {
      doctorOptions = parseDoctorArguments(args);
      args = [];
    }
    if (args.length) throw new Error('invalid_arguments');
    if (!boundRepository) throw new Error('repository_binding_required');
    const repository = boundRepository;
    if (!isAbsolute(repository)) throw new Error('repository_must_be_absolute');
    if (!['doctor', '.gh.auth'].includes(command) && !existsSync(resolve(repository, '.git'))) throw new Error('not_git_repository_root');
    schema = schemas[command];
    if (command === 'spec') return await runSpec(repository, specOptions);
    let report;
    if (command === 'doctor') report = await doctor(repository, { ...doctorOptions, fixedRepository: true });
    else if (command === 'init') report = await runInit(repository);
    else if (command === 'worktree') report = await runWorktree(repository, worktreeOptions);
    else if (command === 'workflow') report = await runWorkflow(repository, workflowOptions);
    else if (command === 'set') report = set(repository, key, value);
    else if (command === 'set.show') report = show(repository);
    else if (command === 'clear') report = clear(repository, key);
    else report = await auth(repository);
    if (command === 'set.show') process.stdout.write(report.content);
    else console.log(JSON.stringify(['workflow', 'worktree'].includes(command) ? workspaceReport(report) : report));
    // Explicit omissions and blocked local checks cannot establish readiness.
    // Preserve the existing zero exit for otherwise healthy, partial online probes.
    if (command === 'doctor' && report.checks?.some(item => item.status === 'not_checked' &&
      (!item.id.endsWith('..online') || ['disabled', 'not_declared'].includes(item.reason)))) return 1;
    return ['ready','local_ready','checks_passed','checks_incomplete'].includes(report.status) ? 0 : 1;
  } catch (error) {
    const reason = /^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$/.test(error.message) ? error.message : 'operation_failed';
    if (command === 'spec') {
      console.log(JSON.stringify(specError(boundRepository, undefined, reason), null, 2));
      return 2;
    }
    if (reason.startsWith('tool_binding')) console.error('Run gidd.pre.ensure.cmd --repo with the target directory to prepare tools and rebuild bindings.');
    const hint = configurationHint(reason); if (hint) console.error(hint);
    if (['.gh', '.git'].includes(command)) {
      console.error(JSON.stringify({ schema: 'gidd.exec/v1', status: 'error', reason,
        ...(error.executionScope ? { details: error.executionScope } : {}) }));
      return 2;
    }
    const worktreeHints = {
      workflow_context_exists: 'A direct-commit workflow record already exists. Use gidd.link workflow.workspace --resume <issue> to continue; after delivery, run gidd.link workflow.cleanup <issue> before starting a new task.',
      workflow_issue_registered: 'This Issue already has a workspace record. Use gidd.link workflow.workspace --resume <issue> to inspect it.',
      workflow_target_branch_required: 'Check out the intended target branch in the target repository, then prepare the workspace again.',
      workflow_context_required: 'No local workspace is recorded for this Issue. Inspect worktree.list, then prepare it with gidd.link workflow.workspace <issue>.',
      workflow_target_checkout_required: 'Check out the recorded target branch in its intended directory, then retry workflow.merge <issue>.',
      workflow_pr_head_changed: 'The PR head differs from the local development commit. Inspect and synchronize the intended changes before retrying.',
      workflow_pr_merge_pending: 'The PR is not confirmed merged. Inspect its checks, branch rules or queue before retrying; retain the workspace.',
      worktree_branch_exists: 'The generated development branch already exists. Inspect it and worktree.list; resume its recorded workflow or resolve the existing branch before preparing this Issue again.',
      workflow_remote_branch_exists: 'The generated development branch already exists on the working remote. Inspect that branch before preparing this Issue again.',
      workflow_workspace_released: 'This dedicated worktree has already been released. Start a new workflow for a new Issue; its directory may be reused.',
      worktree_not_released: 'This directory has not been released. After delivery, run gidd.link workflow.cleanup <issue> before gidd.link worktree.remove <path>.',
      worktree_state_changed: 'The Git checkout no longer matches its verified state. Inspect the registered directory before retrying.',
      worktree_target_repository_protected: 'The target repository checkout cannot be removed by worktree.remove. Use workflow.cleanup to finish its workflow record after delivery.',
      worktree_unknown_selector: command === 'worktree'
        ? 'No GIDD worktree is registered at this directory. Use gidd.link worktree.list to find its path.'
        : 'No GIDD workspace record matches this Issue. Use gidd.link worktree.list to inspect registered workspaces.',
      worktree_pr_not_found: 'No merged PR matches the recorded repository, branches and development commit. Resources are retained; inspect delivery before retrying.',
      worktree_pr_ambiguous: 'Multiple merged PRs match this development branch and commit. Resources are retained; inspect the conflicting delivery records.',
      worktree_pr_discovery_incomplete: 'PR discovery could not inspect the complete matching history. Resources are retained; inspect delivery before cleanup.'
    };
    const errorFields = { schema, status: 'error', reason,
      ...(error.dataReport ? { details: error.dataReport } : {}),
      ...(command === 'init' ? { hint: 'Resolve the reported problem, then rerun gidd.link init. Existing configuration and resources are retained.' } : {}),
      ...(command === 'workflow' && error.workspace ? error.workspace : {}),
      ...(['worktree', 'workflow'].includes(command) && worktreeHints[reason] ? { hint: worktreeHints[reason] } : {}) };
    const errorReport = JSON.stringify(['workflow', 'worktree'].includes(command) ? workspaceReport(errorFields) : errorFields);
    if (command === 'set.show') console.error(errorReport);
    else console.log(errorReport);
    return 2;
  }
}
