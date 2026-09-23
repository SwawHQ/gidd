import * as platform from './checks/tool.platform.mjs';
import * as runtime from './checks/tool.js_runtime.mjs';
import * as git from './checks/tool.git.mjs';
import * as gh from './checks/tool.gh.mjs';
import * as worktree from './checks/folder.git.worktree.mjs';
import * as identity from './checks/folder.git.identity.mjs';
import * as configuration from './checks/config.toml.mjs';
import * as remoteName from './checks/config.repo.remote.name.mjs';
import * as remoteUrl from './checks/config.repo.remote.url.mjs';
import * as remoteAccount from './checks/config.repo.remote.account.mjs';
import * as userMode from './checks/config.git.user.mode.mjs';
import * as userName from './checks/config.git.user.name.mjs';
import * as userEmail from './checks/config.git.user.email.mjs';
import * as credentialMode from './checks/config.git.credential.mode.mjs';
import * as spec from './checks/config.spec.current.mjs';
import * as onlineAccount from './checks/config.repo.remote.account..online.mjs';
import * as onlineRemote from './checks/config.repo.remote.url..online.mjs';

// Each entry owns one ID and returns a diagnostic (or null when inapplicable).
// Add implementations here; references/doctor.toml enables them by stable ID.
// Module names and paths never come from the catalog or repository config.
// This is presentation order. run(context) resolves prerequisites on demand and
// preserves independent errors; a failed prerequisite is not a blanket skip.
// Shared observations stay in the invocation context, never on a module singleton.
export const registry = Object.freeze([
  platform, runtime, git, gh,
  worktree, identity,
  configuration, remoteName, remoteUrl, remoteAccount,
  userMode, userName, userEmail, credentialMode, spec,
  onlineAccount, onlineRemote,
]);
