# Git / GitHub command environment

`gidd.link .gh <args...>` and `gidd.link .git <args...>` start the bound tool in the entry's repository directory. They forward arguments, stdin, stdout, stderr and the exit code. They do not inspect target arguments, restrict repositories, switch the shared gh account, or write Git configuration. Explicit native options such as `--repo`, `-C`, `-c` and `--author` retain their normal meaning. These commands can perform writes when the forwarded command does so.

## Configuration

```toml
schema_version = 1

[repo]
remote.name = "origin"
remote.url = "https://github.com/owner/repo"
remote.account = "your-login"

[git]
user.name = "Commit Name"
user.email = "name@example.com"
credential.mode = "gh"

[spec]
mode = "issue-direct"
```

`git.credential.mode` is required: `gh` supplies gh-backed credentials for the configured HTTPS host; `inherit` leaves Git authentication unchanged. Name/email must appear together, or both may be omitted to use Git's existing identity. No migration or implicit credential mode is provided. `config set` can repair one field at a time; complete the pair before invoking wrappers. No tokens are stored in this file.

## Execution and priority

- `.gh` derives `GH_HOST` and `GH_REPO` from `repo.remote.url`, obtains the saved token for the configured host/account, and verifies it via `api user`. Inherited gh target/token variables are replaced in this child environment. No `auth switch` occurs. Explicit gh targets may override the default repository; they do not change the identity of the supplied token.
- Both entries apply configured `user.name/email` using ordered `GIT_CONFIG_COUNT` entries. These override the same keys in configuration files; explicit `git -c` settings override the injected configuration. Existing author/committer-specific configuration, environment variables, `--author`, and Git's preservation of original authors retain native semantics. Signing configuration is inherited.
- In `gh` mode, the configured HTTPS host's helper list is reset and replaced by a lazy helper. It selects and verifies the saved account token, then delegates the credential response to `gh auth git-credential`. Local Git commands do not acquire credentials or need a login. Missing credentials fail when requested; run `gidd.link auth` to authorize the configured account.
- SSH does not use the HTTPS helper. It retains native SSH authentication in both modes. `inherit` does not guarantee the push account. Other native authentication sources and explicit overrides retain Git semantics; this wrapper is not an authentication enforcement boundary.
- Git commands launched by gh normally inherit the same environment and selected Git path. Programs that replace that environment or pass their own configuration follow native rules; GIDD does not monitor or restrict descendants. Cancellation stops the launched command tree on Windows.
- `GH_REPO` does not redirect Git push. Git still selects its destination from remotes, branch settings and explicit arguments. `doctor` diagnoses configured remote consistency and effective identity; execution does not reject intentional target overrides.
- Internal token acquisition is captured privately and diagnostics do not print tokens. Forwarded commands preserve their native output, including credential output if that is what the caller explicitly requests.

## 中文摘要

两入口提供默认环境，显式参数交给 Git/gh 处理。`git.credential.mode` 必须填写 `gh` 或 `inherit`；姓名和邮箱必须成对填写，或均省略。`.gh` 从配置 URL 设置默认 host/repo，并使用指定账号已保存的 token；`.git` 用环境配置覆盖同名文件配置，保留 `-c`、`--author`、历史作者及签名的原生语义。

`gh` 模式仅为指定 HTTPS host 配置按需认证助手，不禁止 SSH。Git 本地操作不需要登录；缺少凭据时，在实际请求凭据的阶段失败。两入口不会限制跨仓库参数，也不修改全局身份或切换共享活动账号。`doctor` 用于诊断配置和实际生效身份，不能证明推送账号或权限。
