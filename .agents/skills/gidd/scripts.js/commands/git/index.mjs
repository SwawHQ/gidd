import { passthrough } from '../../shared/passthrough.mjs';
import { withSignals } from '../../shared/signals.mjs';

export const git = (repository, args) => withSignals(signal => passthrough(repository, 'git', args, { signal }));
