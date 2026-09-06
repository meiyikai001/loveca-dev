import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseClassifierYaml } from '../../src/server/services/deck-classifier-yaml';
import { buildRankedDeckObservation } from '../../src/server/services/ranked-deck-observation-service';

function fixture() {
  const members = Array.from({ length: 12 }, (_, i) => ({
    card_code: `PL!N-bp1-${String(i + 1).padStart(3, '0')}-N`,
    count: 4,
  }));
  const lives = Array.from({ length: 3 }, (_, i) => ({
    card_code: `PL!N-bp1-${String(i + 13).padStart(3, '0')}-N`,
    count: 4,
  }));
  return {
    player_name: '测试 YAML',
    main_deck: { members, lives },
    energy_deck: [{ card_code: 'ignored-energy', count: 12 }],
  };
}

describe('classifier YAML main deck', () => {
  it('reuses the exported format, merges rarities and matches the ranked fingerprint', () => {
    const data = fixture();
    data.main_deck.members[0].count = 2;
    data.main_deck.members.push({
      ...data.main_deck.members[0],
      card_code: data.main_deck.members[0].card_code.replace(/-N$/, '-P'),
    });
    const result = parseClassifierYaml(stringify(data));
    expect(result).toMatchObject({ suggestedName: '测试 YAML', memberTotal: 48, liveTotal: 12 });
    expect(result.cards).toHaveLength(15);
    expect(result.cards.every((card) => card.count === 4)).toBe(true);
    const cards = [
      ...data.main_deck.members.map((card) => ({ ...card, cardType: 'MEMBER' })),
      ...data.main_deck.lives.map((card) => ({ ...card, cardType: 'LIVE' })),
    ];
    const observation = buildRankedDeckObservation({
      seasonId: 'season',
      matchId: 'match',
      seat: 'FIRST',
      userId: 'user',
      observedAt: new Date(),
      mainDeck: cards.flatMap((card) => Array<string>(card.count).fill(card.card_code)),
      cardSummaries: Object.fromEntries(
        cards.map((card) => [
          card.card_code,
          {
            cardCode: card.card_code,
            name: card.card_code.replace(/-[NP]$/, ''),
            cardType: card.cardType,
          },
        ])
      ),
    });
    expect(result.deckFingerprint).toBe(observation.deckFingerprint);
  });

  it.each([
    '',
    'x'.repeat(65537),
    '# ' + '中'.repeat(23000),
    'player_name: [',
    'player_name: a\nplayer_name: b',
    'a: &a [*a]',
    '!!unknown value',
    '---\na: b\n---\nc: d',
  ])('rejects empty, oversized or malformed YAML %#', (text) => {
    expect(() => parseClassifierYaml(text)).toThrow();
  });
  it('rejects missing structure, fractional counts, wrong totals and excess copies across rarities', () => {
    const data = fixture();
    expect(() => parseClassifierYaml('player_name: test')).toThrow('结构无效');
    data.main_deck.members[0].count = 1.5;
    expect(() => parseClassifierYaml(stringify(data))).toThrow();
    data.main_deck.members[0].count = 3;
    expect(() => parseClassifierYaml(stringify(data))).toThrow();
    data.main_deck.members[0].count = 4;
    data.main_deck.members[1].card_code = data.main_deck.members[0].card_code.replace(/-N$/, '-P');
    expect(() => parseClassifierYaml(stringify(data))).toThrow();
  });
});
