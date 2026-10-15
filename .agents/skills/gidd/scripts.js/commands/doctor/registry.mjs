import * as platform from './checks/tool.platform.mjs';
import * as runtime from './checks/tool.js_runtime.mjs';
import * as git from './checks/tool.git.mjs';
import * as gh from './checks/tool.gh.mjs';
import * as worktree from './checks/folder.git.worktree.mjs';
import * as identity from './checks/folder.git.identity.mjs';
import * as configuration from './checks/config.toml.mjs';
import * as storage from './checks/folder.gidd.mjs';
import * as remote from './checks/folder.git.remote.mjs';
import * as taskRemote from './checks/folder.gidd.remote.mjs';
import * as flow from './checks/folder.gidd.flow.mjs';
import * as language from './checks/config.ui.language.mjs';
import * as onlineAccount from './checks/tool.gh.account..online.mjs';
import * as onlineRemote from './checks/folder.git.remote..online.mjs';

// Each entry owns one ID and returns a diagnostic (or null when inapplicable).
// Add implementations here; references/doctor.toml enables them by stable ID.
// Module names and paths never come from the catalog or repository config.
// This is presentation order. run(context) resolves prerequisites on demand and
// preserves independent errors; a failed prerequisite is not a blanket skip.
// Shared observations stay in the invocation context, never on a module singleton.
export const registry = Object.freeze([
  platform, runtime, git, gh,
  worktree, identity, storage,
  configuration, language, remote, taskRemote,
  flow,
  onlineAccount, onlineRemote,
]);
