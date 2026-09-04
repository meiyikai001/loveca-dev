import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AiDecisionTraceRecorder } from '../src/server/services/ai-decision-trace-recorder.js';
import { runAiSelfPlay } from '../src/server/services/ai-self-play-runner.js';
import {
  createSeededRandomInt,
  loadLocalSelfPlayDecks,
  LOCAL_RANDOMNESS_NOTE,
} from './ai-self-play-local-input.js';

const CARDS_PATH = fileURLToPath(new URL('../llocg_db/json/cards.json', import.meta.url));
const OPTIONS = new Set([
  'deck',
  'opponent-deck',
  'seed',
  'max-steps',
  'max-turns',
  'output',
  'trace-dir',
]);

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
    ...(values.has('trace-dir') ? { traceDir: requiredPath('trace-dir') } : {}),
  };
}

async function assertNewPath(path: string): Promise<void> {
  // Include directories and dangling symlinks, not only regular files.
  try {
    await lstat(path);
    throw new Error(`Refusing to overwrite existing output: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function assertSeparatePaths(output: string, traceDir: string): void {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
  };
  if (contains(output, traceDir) || contains(traceDir, output)) {
    throw new Error('Conflicting output and trace-dir paths: neither may contain the other');
  }
}

export async function runAiSelfPlayCli(args: readonly string[]): Promise<void> {
  const options = parseAiSelfPlayCliArgs(args);
  if (options.traceDir) assertSeparatePaths(options.outputPath, options.traceDir);
  await assertNewPath(options.outputPath);
  if (options.traceDir) {
    await assertNewPath(options.traceDir);
    // Resolve existing parent-directory aliases before reserving either output. No mkdir -p.
    const [outputParent, traceParent] = await Promise.all([
      realpath(dirname(options.outputPath)),
      realpath(dirname(options.traceDir)),
    ]);
    assertSeparatePaths(
      resolve(outputParent, basename(options.outputPath)),
      resolve(traceParent, basename(options.traceDir))
    );
  }
  const decks = await loadLocalSelfPlayDecks(
    options.deckPath,
    options.opponentDeckPath,
    CARDS_PATH
  );
  // Trace mode reserves the main output first, before creating or writing private artifacts.
  // Without trace mode the existing end-of-run exclusive report creation remains unchanged.
  const reportFile = options.traceDir ? await open(options.outputPath, 'wx', 0o600) : undefined;
  try {
    if (options.traceDir) await mkdir(options.traceDir, { mode: 0o700 });
    const traceRecorder = options.traceDir ? new AiDecisionTraceRecorder() : undefined;
    const report = await runAiSelfPlay({
      ...decks,
      randomInt: options.seed === undefined ? undefined : createSeededRandomInt(options.seed),
      maxSteps: options.maxSteps,
      maxTurns: options.maxTurns,
      ...(traceRecorder ? { traceRecorder } : {}),
    });
    // Keep the public report schema unchanged; per-seat private traces are separate documents.
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
    const serialized = `${JSON.stringify(output, null, 2)}\n`;
    if (reportFile) await reportFile.writeFile(serialized);
    else await writeFile(options.outputPath, serialized, { flag: 'wx' });
    if (traceRecorder && options.traceDir) {
      for (const [seat, filename] of [
        ['FIRST', 'first.json'],
        ['SECOND', 'second.json'],
      ] as const) {
        await writeFile(
          resolve(options.traceDir, filename),
          `${JSON.stringify(traceRecorder.getSeatTrace(seat), null, 2)}\n`,
          { flag: 'wx', mode: 0o600 }
        );
      }
    }
  } catch (error) {
    if (reportFile) {
      throw new Error(
        `Self-play outputs are incomplete; created files were retained. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    await reportFile?.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runAiSelfPlayCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
