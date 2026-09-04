import { lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runAiSelfPlay } from '../src/server/services/ai-self-play-runner.js';
import {
  createSeededRandomInt,
  loadLocalSelfPlayDecks,
  LOCAL_RANDOMNESS_NOTE,
} from './ai-self-play-local-input.js';

const CARDS_PATH = fileURLToPath(new URL('../llocg_db/json/cards.json', import.meta.url));
const OPTIONS = new Set(['deck', 'opponent-deck', 'seed', 'max-steps', 'max-turns', 'output']);

export function parseAiSelfPlayCliArgs(args: readonly string[]) {
  const values = new Map<string, string>();
  for (const argument of args) {
    const match = /^--([^=]+)=(.+)$/.exec(argument);
    if (!match || !OPTIONS.has(match[1]))
      throw new Error(`Unknown or invalid argument: ${argument}`);
    if (values.has(match[1])) throw new Error(`Duplicate argument: --${match[1]}`);
    values.set(match[1], match[2]);
  }
  const requiredPath = (name: string) => {
    const value = values.get(name);
    if (!value?.trim()) throw new Error(`--${name}=<path> is required`);
    return resolve(value);
  };
  const number = (name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
  };
  const deckPath = requiredPath('deck');
  return {
    deckPath,
    opponentDeckPath: values.has('opponent-deck') ? requiredPath('opponent-deck') : deckPath,
    outputPath: requiredPath('output'),
    seed: number('seed', 0, 0xffff_ffff),
    maxSteps: number('max-steps', 1),
    maxTurns: number('max-turns', 1),
  };
}

export async function runAiSelfPlayCli(args: readonly string[]): Promise<void> {
  const options = parseAiSelfPlayCliArgs(args);
  // lstat rejects existing files, directories, and even dangling symlinks before simulation.
  try {
    await lstat(options.outputPath);
    throw new Error(`Refusing to overwrite existing output: ${options.outputPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const decks = await loadLocalSelfPlayDecks(
    options.deckPath,
    options.opponentDeckPath,
    CARDS_PATH
  );
  const report = await runAiSelfPlay({
    ...decks,
    randomInt: options.seed === undefined ? undefined : createSeededRandomInt(options.seed),
    maxSteps: options.maxSteps,
    maxTurns: options.maxTurns,
  });
  // The runner returns a report, not authority state or either provider's private observation.
  const output = {
    ...report,
    input: {
      deck: options.deckPath,
      opponentDeck: options.opponentDeckPath,
      cards: CARDS_PATH,
      seed: options.seed ?? null,
      randomnessNote: LOCAL_RANDOMNESS_NOTE,
    },
  };
  // Exclusive creation also closes the race between the preflight check and finishing a run.
  await writeFile(options.outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runAiSelfPlayCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
