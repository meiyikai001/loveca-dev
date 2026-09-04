import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { DeckConfig } from '../src/application/game-service.js';
import { inheritMissingBladeHeartsByBase } from '../src/domain/card-data/blade-heart-inheritance.js';
import {
  CardDataRegistry,
  DeckConfigSchema,
  DeckLoader,
  type DeckConfig as YamlDeckConfig,
} from '../src/domain/card-data/deck-loader.js';
import {
  createHeartRequirement,
  type AnyCardData,
  type BladeHeartItem,
  type HeartIcon,
} from '../src/domain/entities/card.js';
import { validateDeck } from '../src/domain/rules/deck-validator.js';
import { appendDoubleGrayBladeHearts } from '../src/scripts/card-sync-double-heart.js';
import {
  LOVECA_SYNC_BLADE_HEART_COLOR_MAP,
  LOVECA_SYNC_HEART_COLOR_MAP,
  LOVECA_SYNC_RAINBOW_HEART_TOKENS,
} from '../src/scripts/card-sync-heart-colors.js';
import type { RandomIntegerSource } from '../src/shared/random-source.js';
import { BladeHeartEffect, CardType, HeartColor } from '../src/shared/types/enums.js';
import { getBaseCardCode, normalizeCardCode } from '../src/shared/utils/card-code.js';

export const LOCAL_RANDOMNESS_NOTE =
  'Seed controls only randomness routed through this GameSession; it is not a complete deterministic replay.';

export function createSeededRandomInt(seed: number): RandomIntegerSource {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error('seed must be a nonnegative uint32');
  }
  let state = seed;
  return (maxExclusive) => {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error('random upper bound must be a positive safe integer');
    }
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % maxExclusive;
  };
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, context: string, required = false): string | undefined {
  if (value == null && !required) return undefined;
  if (typeof value !== 'string' || (required && value.trim() === '')) {
    throw new Error(`${context}: expected ${required ? 'nonempty ' : ''}text`);
  }
  return value || undefined;
}

function integer(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context}: expected a nonnegative safe integer`);
  }
  return value;
}

// Source-format aliases, not card-specific rules. Color semantics remain shared with sync.
const LLOCG_HEART_TOKENS: Readonly<Record<string, string>> = {
  heart01: 'pink',
  heart02: 'red',
  heart03: 'yellow',
  heart04: 'green',
  heart05: 'blue',
  heart06: 'purple',
  heart0: 'any',
};

function sourceCounts(value: unknown, context: string): Array<[string, number]> {
  if (value == null) return [];
  return Object.entries(object(value, context)).map(([token, count]) => [
    token,
    integer(count, `${context}.${token}`),
  ]);
}

function hearts(value: unknown, context: string): HeartIcon[] {
  return sourceCounts(value, context).flatMap(([rawToken, count]) => {
    if (count === 0) return [];
    const token = LLOCG_HEART_TOKENS[rawToken] ?? rawToken;
    const color = LOVECA_SYNC_RAINBOW_HEART_TOKENS.has(token)
      ? HeartColor.RAINBOW
      : (LOVECA_SYNC_HEART_COLOR_MAP[token] as HeartColor | undefined);
    if (!color) throw new Error(`${context}: unknown nonzero heart token ${rawToken}`);
    return [{ color, count }];
  });
}

function bladeHearts(row: Record<string, unknown>, context: string): BladeHeartItem[] {
  const result: BladeHeartItem[] = [];
  for (const field of ['blade_heart', 'special_heart'] as const) {
    for (const [rawToken, count] of sourceCounts(row[field], `${context}.${field}`)) {
      if (count === 0) continue;
      const withoutPrefix = rawToken.replace(/^b_/, '');
      const token = LLOCG_HEART_TOKENS[withoutPrefix] ?? withoutPrefix;
      if (appendDoubleGrayBladeHearts(result, token, count)) continue;
      const color = LOVECA_SYNC_BLADE_HEART_COLOR_MAP[token] as HeartColor | undefined;
      const effect =
        token === 'draw'
          ? BladeHeartEffect.DRAW
          : token === 'score'
            ? BladeHeartEffect.SCORE
            : undefined;
      if (!color && !effect) {
        throw new Error(`${context}.${field}: unknown nonzero blade heart token ${rawToken}`);
      }
      for (let index = 0; index < count; index++) {
        result.push(
          color ? { effect: BladeHeartEffect.HEART, heartColor: color } : { effect: effect! }
        );
      }
    }
  }
  return result;
}

function cardType(value: unknown, context: string): CardType {
  switch (value) {
    case 'メンバー':
      return CardType.MEMBER;
    case 'ライブ':
      return CardType.LIVE;
    case 'エネルギー':
      return CardType.ENERGY;
    default:
      throw new Error(`${context}: unknown card type ${String(value)}`);
  }
}

/** Read-only local test-input adapter. Never imports a sync entry point or database service. */
export function buildLocalLlocgRegistry(
  raw: unknown,
  requiredCodes: readonly string[]
): CardDataRegistry {
  const required = new Set(requiredCodes.map(normalizeCardCode));
  const requiredBases = new Set([...required].map(getBaseCardCode));
  const seen = new Set<string>();
  const siblings = Object.entries(object(raw, 'cards.json')).flatMap(([sourceCode, value]) => {
    const code = normalizeCardCode(sourceCode);
    if (!requiredBases.has(getBaseCardCode(code))) return [];
    if (seen.has(code)) throw new Error(`cards.json: duplicate normalized card code ${code}`);
    seen.add(code);
    const row = object(value, code);
    if (normalizeCardCode(text(row.card_no, `${code}.card_no`, true)!) !== code) {
      throw new Error(`${code}: card_no differs from the source key`);
    }
    return [
      {
        card_code: code,
        card_type: cardType(row.type, code),
        blade_hearts: bladeHearts(row, code),
        row,
      },
    ];
  });
  const cards: AnyCardData[] = inheritMissingBladeHeartsByBase(siblings)
    .filter((record) => required.has(record.card_code))
    .map(({ card_code: code, card_type: type, blade_hearts: blade, row }) => {
      const name = text(row.name, `${code}.name`, true)!;
      const ability = text(row.ability, `${code}.ability`);
      const unit = text(row.unit, `${code}.unit`);
      const base = {
        cardCode: code,
        name,
        nameJp: name,
        cardText: ability,
        cardTextJp: ability,
        // llocg series is an official work name, not a manually curated group override.
        workNames: text(row.series, `${code}.series`)
          ?.split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        unitName: unit,
        unitNameRaw: unit,
        bladeHearts: blade,
        rare: text(row.rare, `${code}.rare`),
        product: text(row.product, `${code}.product`),
      };
      if (type === CardType.MEMBER) {
        // llocg omits zero cost/blade values; the existing registry uses the same zero default.
        return {
          ...base,
          cardType: type,
          cost: integer(row.cost ?? 0, `${code}.cost`),
          blade: integer(row.blade ?? 0, `${code}.blade`),
          hearts: hearts(row.base_heart, `${code}.base_heart`),
        };
      }
      if (type === CardType.LIVE) {
        const requirements = hearts(row.need_heart, `${code}.need_heart`);
        const counts: Record<string, number> = {};
        for (const { color, count } of requirements) counts[color] = (counts[color] ?? 0) + count;
        return {
          ...base,
          cardType: type,
          score: integer(row.score, `${code}.score`),
          requirements: createHeartRequirement(counts),
        };
      }
      return { ...base, cardType: CardType.ENERGY };
    });
  const registry = new CardDataRegistry();
  registry.load(cards);
  return registry;
}

function parseDeckYaml(content: string): YamlDeckConfig {
  const config = DeckConfigSchema.parse(parse(content));
  for (const entry of [
    ...config.main_deck.members,
    ...config.main_deck.lives,
    ...config.energy_deck,
  ]) {
    entry.card_code = normalizeCardCode(entry.card_code);
  }
  return config;
}

export async function loadLocalSelfPlayDecks(
  firstPath: string,
  secondPath: string,
  cardsPath: string
): Promise<{ firstDeck: DeckConfig; secondDeck: DeckConfig }> {
  const [firstYaml, secondYaml, cardsJson] = await Promise.all([
    readFile(firstPath, 'utf8'),
    readFile(secondPath, 'utf8'),
    readFile(cardsPath, 'utf8'),
  ]);
  const configs = [parseDeckYaml(firstYaml), parseDeckYaml(secondYaml)];
  const codes = configs.flatMap((config) =>
    [...config.main_deck.members, ...config.main_deck.lives, ...config.energy_deck].map(
      (entry) => entry.card_code
    )
  );
  const loader = new DeckLoader(buildLocalLlocgRegistry(JSON.parse(cardsJson), codes));
  const decks = configs.map((config) => {
    const result = loader.loadFromConfig(config);
    if (!result.success || !result.deck) throw new Error(result.errors.join('; '));
    const { mainDeck, energyDeck } = result.deck;
    const validation = validateDeck(mainDeck, energyDeck);
    if (!validation.valid)
      throw new Error(validation.errors.map((error) => error.message).join('; '));
    return { mainDeck, energyDeck };
  });
  return { firstDeck: decks[0], secondDeck: decks[1] };
}
