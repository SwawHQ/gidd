import { main } from './gidd.mjs';

export async function start(args = process.argv.slice(1)) {
  delete process.env.GIDD_ENTRY_DIRECTORY;
  delete process.env.GIDD_ENTRY_LOADER;
  process.exitCode = await main(args);
}
