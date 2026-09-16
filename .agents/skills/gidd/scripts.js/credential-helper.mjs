import { selectGitHubAccount } from './execution-env.mjs';
import { runCommand, validateOptions } from './github.mjs';

// Git's credential protocol is private stdin/stdout, not GIDD diagnostic output.
// Delegate credential formatting to gh after selecting the configured account.
const [gh, hostname, account, operation] = process.argv.slice(2);
try {
  if (operation === 'get') {
    validateOptions({ repository: process.cwd(), gh, hostname, account, remote: 'origin' });
    let request = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      request += chunk;
      if (request.length > 65536) throw new Error('credential_request_too_large');
    }
    const fields = Object.fromEntries(request.split(/\r?\n/).filter(line => line.includes('=')).map(line => {
      const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
    }));
    // This helper only owns its configured HTTPS host. Other destinations retain
    // Git's own behavior; this is not a remote/argument restriction.
    if (fields.protocol === 'https' && fields.host?.toLowerCase() === hostname.toLowerCase()) {
      const selected = await selectGitHubAccount({ gh, hostname, account }, { cwd: process.cwd() });
      const result = await runCommand(gh, ['auth', 'git-credential', 'get'], { env: selected.env, input: request });
      if (!result.ok) throw new Error(result.reason);
      process.stdout.write(result.text + '\n\n');
    }
  } else if (!['store', 'erase'].includes(operation)) throw new Error('invalid_credential_operation');
} catch (error) {
  const reason = /^[a-z_]+$/.test(error.message) ? error.message : 'credential_helper_failed';
  process.stderr.write(`GIDD credential helper: ${reason}. Run gidd.link.cmd auth if credentials are missing.\n`);
  process.stdout.write('quit=true\n\n');
  process.exitCode = 1;
}
