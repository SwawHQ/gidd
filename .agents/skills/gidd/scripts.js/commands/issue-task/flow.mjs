import { resolve } from 'node:path';
import { readTask } from '../../shared/task-records.mjs';
import { flowStorage } from '../../shared/flow-history.mjs';
import { loadFlow, flowRoot } from '../../shared/flows.mjs';
import { resolveLanguage } from '../../shared/language.mjs';
import { boundExecutor, boundTools } from '../../shared/bindings.mjs';
import { locateStorage } from '../../shared/managed-storage.mjs';
import { noninteractiveEnvironment } from '../../shared/noninteractive.mjs';
import { toolsRoot } from '../../shared/storage.mjs';
import { renderFlow, flowError } from '../flow/index.mjs';

export function issueTaskFlowCommand(repository, options, root = flowRoot) {
  const lang = resolveLanguage(options.lang, 'unsupported_help_language', repository);
  let selector;
  try {
    const saved = readTask(flowStorage(repository), options.issue).flow;
    selector = saved.selector;
    const flow = loadFlow(selector, root);
    if (saved.mode !== flow.mode) throw new Error('task_flow_changed');
    flow.authorization = saved.authorization;
    const notice = lang === 'zh-CN'
      ? `任务：Issue #${options.issue}。以下确认点使用任务保存的记录。\n\n`
      : `Task: Issue #${options.issue}. Approval points below use the saved task record.\n\n`;
    return { markdown: notice + renderFlow(repository, flow, lang), exitCode: 0 };
  } catch (error) {
    return { report: flowError(repository, selector, error.message, lang, {
      ...(error.path ? { path: error.path } : {}), ...(error.field ? { field: error.field } : {}),
      ...(error.conflicts ? { conflicts: error.conflicts } : {}),
    }), exitCode: 1 };
  }
}

export async function runIssueTaskFlow(repository, options) {
  const bindings = boundTools(toolsRoot(), ['git']), execute = boundExecutor(bindings);
  const storage = await locateStorage(repository, async (path, args) => {
    const result = await execute(bindings.git.path, ['-C', path, ...args],
      { env: noninteractiveEnvironment(bindings.git.path, process.env), timeoutMs: 60000 });
    if (!result.ok) throw new Error('data_git_failed');
    return result.text;
  });
  const result = issueTaskFlowCommand(resolve(storage.main), options);
  if (result.markdown !== undefined) process.stdout.write(result.markdown);
  else console.log(JSON.stringify(result.report, null, 2));
  return result.exitCode;
}
