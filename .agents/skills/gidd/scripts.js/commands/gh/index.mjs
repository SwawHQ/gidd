import { passthrough } from '../../shared/passthrough.mjs';
import { withSignals } from '../../shared/signals.mjs';

export const gh = (repository, args) => withSignals(signal => passthrough(repository, 'gh', args, { signal }));
