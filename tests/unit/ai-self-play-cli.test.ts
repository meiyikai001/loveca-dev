import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLocalLlocgRegistry,
  createSeededRandomInt,
  loadLocalSelfPlayDecks,
  LOCAL_RANDOMNESS_NOTE,
} from '../../scripts/ai-self-play-local-input.js';
import { parseAiSelfPlayCliArgs, runAiSelfPlayCli } from '../../scripts/run-ai-self-play.js';
import {
  runAiSelfPlay,
  type AiSelfPlayReport,
} from '../../src/server/services/ai-self-play-runner.js';
import { CardType, HeartColor } from '../../src/shared/types/enums.js';

vi.mock('../../src/server/services/ai-self-play-runner.js', () => ({ runAiSelfPlay: vi.fn() }));

const DECK_PATH = fileURLToPath(new URL('../../assets/decks/绿莲-6弹ver.yaml', import.meta.url));
const CARDS_PATH = fileURLToPath(new URL('../../llocg_db/json/cards.json', import.meta.url));
const TEMP_DIRS: string[] = [];
async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'loveca-self-play-cli-'));
  TEMP_DIRS.push(path);
  return path;
}
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(TEMP_DIRS.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('self-play CLI arguments and local random source', () => {
  it('requires explicit paths, defaults to the same deck, and accepts uint32 endpoints', () => {
    const args = parseAiSelfPlayCliArgs([
      '--deck=example.yaml',
      '--output=result.json',
      '--seed=0',
      '--max-steps=9',
      '--max-turns=2',
    ]);
    expect(args).toEqual({
      deckPath: resolve('example.yaml'),
      opponentDeckPath: resolve('example.yaml'),
      outputPath: resolve('result.json'),
      seed: 0,
      maxSteps: 9,
      maxTurns: 2,
    });
    expect(
      parseAiSelfPlayCliArgs(['--deck=a', '--opponent-deck=b', '--output=c', '--seed=4294967295'])
    ).toMatchObject({ opponentDeckPath: resolve('b'), seed: 4294967295 });
  });

  it.each(
    [
      [],
      ['--deck=x'],
      ['--output=y'],
      ['--deck=x', '--deck=y', '--output=z'],
      ['--deck=x', '--output=z', '--unknown=1'],
      ['--deck=x', '--output=z', '--seed=-1'],
      ['--deck=x', '--output=z', '--seed=4294967296'],
      ['--deck=x', '--output=z', '--seed=1.5'],
      ['--deck=x', '--output=z', '--seed=1e2'],
      ['--deck=x', '--output=z', '--max-steps=0'],
      ['--deck=x', '--output=z', '--max-turns=Infinity'],
      ['--deck=x', '--output=z', '--max-turns=9007199254740992'],
      ['--deck= ', '--output=z'],
      ['--deck=x', '--output='],
    ].map((args) => ({ args }))
  )('rejects missing, duplicate, unknown or unsafe arguments: $args', ({ args }) => {
    expect(() => parseAiSelfPlayCliArgs(args)).toThrow();
  });

  it('has isolated seeded sequences without modifying global randomness', () => {
    const globalRandom = Math.random;
    const first = createSeededRandomInt(0);
    const second = createSeededRandomInt(0);
    expect([first(2 ** 32), first(2 ** 32), first(2 ** 32)]).toEqual([
      1_013_904_223, 1_196_435_762, 3_519_870_697,
    ]);
    expect(second(2 ** 32)).toBe(1_013_904_223);
    expect(createSeededRandomInt(1)(2 ** 32)).not.toBe(1_013_904_223);
    expect(Math.random).toBe(globalRandom);
    expect(() => createSeededRandomInt(-1)).toThrow();
    expect(() => createSeededRandomInt(2 ** 32)).toThrow();
    expect(() => first(0)).toThrow();
    expect(() => first(Infinity)).toThrow();
  });
});

const MEMBER_CODE = 'PL!HS-bp6-017-N';
const member = {
  card_no: MEMBER_CODE,
  name: '日野下花帆',
  type: 'メンバー',
  cost: 11,
  blade: 3,
  series: 'ラブライブ！蓮ノ空女学院スクールアイドルクラブ',
  unit: 'スリーズブーケ',
  ability: '{{jidou.png|自動}}原文を保持。',
  base_heart: { heart04: 2 },
};

describe('read-only llocg input adapter', () => {
  it('preserves source text, work/unit identity and inherited blade hearts without invented group overrides', () => {
    const foilCode = 'PL!HS-bp6-017-P＋';
    const raw = {
      [MEMBER_CODE]: {
        ...member,
        blade_heart: { b_heart04: 1 },
        special_heart: { draw: 1, score: 1, double: 1 },
      },
      [foilCode]: { ...member, card_no: foilCode, blade: undefined },
      unrelated: { type: 'UNSUPPORTED', blade_heart: { unrecognized: 9 } },
    };
    const card = buildLocalLlocgRegistry(raw, ['PL!HS-bp6-017-P+']).getByCode('PL!HS-bp6-017-P+');
    expect(card).toMatchObject({
      cardType: CardType.MEMBER,
      cost: 11,
      blade: 0,
      cardText: member.ability,
      cardTextJp: member.ability,
      unitName: member.unit,
      workNames: [member.series],
      hearts: [{ color: HeartColor.GREEN, count: 2 }],
      bladeHearts: [
        { effect: 'HEART', heartColor: 'GREEN' },
        { effect: 'DRAW' },
        { effect: 'SCORE' },
        { effect: 'HEART', heartColor: 'GRAY' },
        { effect: 'HEART', heartColor: 'GRAY' },
      ],
    });
    expect(card).not.toHaveProperty('groupNames');
    expect(raw[foilCode]).not.toHaveProperty('blade_heart');
  });

  it('converts LIVE requirements into the runtime map, including generic and orange hearts', () => {
    const code = 'PL!HS-bp6-027-L';
    const card = buildLocalLlocgRegistry(
      {
        [code]: {
          card_no: code,
          name: 'LIVE',
          type: 'ライブ',
          score: 5,
          need_heart: { heart04: 4, green: 1, heart0: 6, orange: 1 },
          blade_heart: { b_all: 1 },
        },
      },
      [code]
    ).getByCode(code);
    expect(card?.cardType).toBe(CardType.LIVE);
    if (card?.cardType !== CardType.LIVE) throw new Error('expected LIVE');
    expect(card.requirements.totalRequired).toBe(12);
    expect(card.requirements.colorRequirements.get(HeartColor.GREEN)).toBe(5);
    expect(card.requirements.colorRequirements.get(HeartColor.RAINBOW)).toBe(6);
    expect(card.requirements.colorRequirements.get(HeartColor.ORANGE)).toBe(1);
    expect(card.bladeHearts).toEqual([{ effect: 'HEART', heartColor: 'RAINBOW' }]);
  });

  it.each([
    { base_heart: { unknown: 1 } },
    { blade_heart: { unknown: 1 } },
    { special_heart: { unknown: 1 } },
    { base_heart: { heart04: -1 } },
    { base_heart: { heart04: 1.2 } },
    { cost: '11' },
    { type: 'unknown' },
    { card_no: 'PL!HS-bp6-018-N' },
    { ability: { invalid: true } },
  ])('rejects unsupported rule input instead of discarding it: %j', (invalid) => {
    expect(() =>
      buildLocalLlocgRegistry({ [MEMBER_CODE]: { ...member, ...invalid } }, [MEMBER_CODE])
    ).toThrow();
  });

  it('loads the actual green Hasunosora deck using local files only', async () => {
    const before = await readFile(DECK_PATH, 'utf8');
    const { firstDeck, secondDeck } = await loadLocalSelfPlayDecks(
      DECK_PATH,
      DECK_PATH,
      CARDS_PATH
    );
    expect(firstDeck.mainDeck).toHaveLength(60);
    expect(firstDeck.energyDeck).toHaveLength(12);
    expect(firstDeck.mainDeck.filter((card) => card.cardType === CardType.MEMBER)).toHaveLength(48);
    expect(firstDeck.mainDeck).toEqual(secondDeck.mainDeck);
    expect(firstDeck.mainDeck).not.toBe(secondDeck.mainDeck);
    expect(await readFile(DECK_PATH, 'utf8')).toBe(before);
    expect(firstDeck.mainDeck.find((card) => card.cardCode === 'PL!HS-pb1-004-R')).toMatchObject({
      blade: 0,
    });
  });

  it('rejects invalid deck counts and missing cards before simulation', async () => {
    const dir = await temporaryDirectory();
    const deck = join(dir, 'bad.yaml');
    await writeFile(
      deck,
      'player_name: test\nmain_deck:\n  members: []\n  lives: []\nenergy_deck: []\n'
    );
    await expect(loadLocalSelfPlayDecks(deck, deck, CARDS_PATH)).rejects.toThrow('60');
    await writeFile(
      deck,
      'player_name: test\nmain_deck:\n  members: [{card_code: PL!HS-bp99-001-R, count: 4}]\n  lives: []\nenergy_deck: []\n'
    );
    await expect(loadLocalSelfPlayDecks(deck, deck, CARDS_PATH)).rejects.toThrow('卡牌不存在');
  });
});

const REPORT: AiSelfPlayReport = {
  schemaVersion: 1,
  status: 'LIMIT_REACHED',
  stopReason: 'MAX_STEPS',
  final: null,
  steps: [],
  wallTimeMs: 2,
  providerTimeMs: 1,
  virtualWaitMs: 0,
  blocker: null,
};

describe('self-play CLI output boundary', () => {
  it('writes only the returned report plus input metadata and passes local bounds/RNG', async () => {
    const dir = await temporaryDirectory();
    const output = join(dir, 'report.json');
    vi.mocked(runAiSelfPlay).mockResolvedValue(REPORT);
    await runAiSelfPlayCli([
      `--deck=${DECK_PATH}`,
      `--output=${output}`,
      '--seed=0',
      '--max-steps=3',
      '--max-turns=2',
    ]);
    const saved: unknown = JSON.parse(await readFile(output, 'utf8'));
    expect(saved).toEqual({
      ...REPORT,
      input: {
        deck: DECK_PATH,
        opponentDeck: DECK_PATH,
        cards: CARDS_PATH,
        seed: 0,
        randomnessNote: LOCAL_RANDOMNESS_NOTE,
      },
    });
    const input = vi.mocked(runAiSelfPlay).mock.calls[0][0];
    expect(input).toMatchObject({ maxSteps: 3, maxTurns: 2 });
    expect(input.firstDeck.mainDeck).toHaveLength(60);
    expect(input.randomInt?.(2 ** 32)).toBe(1_013_904_223);
    expect(saved).not.toHaveProperty('state');
  });

  it('rejects an existing output before loading or running, including a dangling symlink', async () => {
    const dir = await temporaryDirectory();
    const output = join(dir, 'report.json');
    await writeFile(output, 'keep me');
    await expect(runAiSelfPlayCli(['--deck=missing.yaml', `--output=${output}`])).rejects.toThrow(
      'Refusing to overwrite'
    );
    expect(await readFile(output, 'utf8')).toBe('keep me');
    const link = join(dir, 'link.json');
    await symlink(join(dir, 'missing-target'), link);
    await expect(runAiSelfPlayCli(['--deck=missing.yaml', `--output=${link}`])).rejects.toThrow(
      'Refusing to overwrite'
    );
    expect(runAiSelfPlay).not.toHaveBeenCalled();
  });

  it('does not overwrite a file created by another process while simulation runs', async () => {
    const dir = await temporaryDirectory();
    const output = join(dir, 'report.json');
    vi.mocked(runAiSelfPlay).mockImplementation(async () => {
      await writeFile(output, 'concurrent owner');
      return REPORT;
    });
    await expect(
      runAiSelfPlayCli([`--deck=${DECK_PATH}`, `--output=${output}`])
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(output, 'utf8')).toBe('concurrent owner');
  });
});
