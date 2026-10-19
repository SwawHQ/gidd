import { configure } from '../../shared/config.mjs';

export function parseLangArguments(route, args) {
  if (route === 'lang.set' && args.length === 1) return { action: 'set', value: args[0] };
  if (route === 'lang.clear' && args.length === 0) return { action: 'clear' };
  throw new Error('invalid_arguments');
}

export const langCommand = (repository, { action, value }) => configure(repository, action, 'ui.language', value);
