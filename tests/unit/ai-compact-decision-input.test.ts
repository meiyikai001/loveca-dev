import { describe, expect, it } from 'vitest';
import {
  compactAiDecisionRequest,
  type AiCompactDecisionInput,
} from '../../src/application/ai/ai-compact-decision-input';
import type {
  AiCardObservationV2,
  AiDecisionRequestV2,
  AiLiveActionObservationV2,
  AiStageSlotObservationV2,
} from '../../src/application/ai/ai-decision-contract';
import {
  BladeHeartEffect,
  CardType,
  HeartColor,
  OrientationState,
  SlotPosition,
} from '../../src/shared/types/enums';

const member: AiCardObservationV2 = {
  cardCode: 'VISIBLE-MEMBER',
  cardType: CardType.MEMBER,
  nameJp: '見えるメンバー',
  nameCn: '可见成员',
  cost: 11,
  blade: 4,
  hearts: [{ color: HeartColor.GREEN, count: 3 }],
  modifierDelta: {
    costDelta: -2,
    bladeDelta: 1,
    heartDeltas: [{ color: HeartColor.RAINBOW, count: 1 }],
  },
  bladeHearts: [
    { effect: BladeHeartEffect.DRAW },
    { effect: BladeHeartEffect.HEART, heartColor: HeartColor.GREEN },
  ],
  cardTextJp: '【登場】【ライブ開始時】省略してはいけないカードテキスト。'.repeat(4),
  cardTextCn: '【登场】【LIVE开始】不能省略的完整卡牌效果文本。'.repeat(4),
};

const live: AiCardObservationV2 = {
  cardCode: 'VISIBLE-LIVE',
  cardType: CardType.LIVE,
  nameJp: '見えるライブ',
  nameCn: '可见LIVE',
  score: 6,
  requiredHearts: {
    colorRequirements: { [HeartColor.GREEN]: 5, [HeartColor.GRAY]: 2 },
    totalRequired: 7,
  },
  bladeHearts: [{ effect: BladeHeartEffect.SCORE }],
  cardTextJp: '【ライブ開始時】省略してはいけないカードテキスト。'.repeat(3),
  cardTextCn: '【LIVE开始】完整卡文包含必要心和分数条件，不作策略概括。'.repeat(3),
};

function stage(): AiStageSlotObservationV2[] {
  return [
    {
      slot: SlotPosition.LEFT,
      member: {
        card: globalThis.structuredClone(member),
        orientation: OrientationState.WAITING,
        effectiveCost: 9,
        effectiveBlade: 5,
        effectiveHearts: [
          { color: HeartColor.GREEN, count: 3 },
          { color: HeartColor.RAINBOW, count: 1 },
        ],
        enteredStageThisTurn: true,
      },
      energyBelowCount: 2,
      membersBelow: [globalThis.structuredClone(member)],
    },
    {
      slot: SlotPosition.CENTER,
      member: null,
      energyBelowCount: 0,
      membersBelow: [],
    },
  ];
}

function observation(): AiLiveActionObservationV2 {
  const energy = {
    activeCount: 2,
    totalCount: 8,
    skipsNextActivePhase: { activeCount: 1, waitingCount: 2 },
  };
  return {
    match: {
      viewerSeat: 'FIRST',
      turnCount: 3,
      phase: 'LIVE_PHASE',
      subPhase: 'LIVE_SET',
      firstSeat: 'FIRST',
      activeSeat: 'FIRST',
      prioritySeat: 'FIRST',
      publicSequence: 12,
      window: null,
    },
    zoneCounts: [
      { zoneKey: 'SECOND_HAND', zone: 'HAND', ownerSeat: 'SECOND', count: 7 },
      { zoneKey: 'FIRST_MAIN_DECK', zone: 'MAIN_DECK', ownerSeat: 'FIRST', count: 22 },
    ],
    self: {
      hand: [
        { handToken: 'hand-1', card: globalThis.structuredClone(member) },
        { handToken: 'hand-2', card: globalThis.structuredClone(member) },
        { handToken: 'hand-3', card: globalThis.structuredClone(live) },
      ],
      stage: stage(),
      energy: globalThis.structuredClone(energy),
    },
    opponent: { seat: 'SECOND', stage: stage(), energy: globalThis.structuredClone(energy) },
    visibleZones: [
      {
        zoneKey: 'FIRST_INSPECTION',
        ordered: true,
        cards: [
          {
            ownerSeat: 'FIRST',
            card: globalThis.structuredClone(member),
            faceDown: false,
            publiclyRevealed: false,
            position: 1,
          },
        ],
        hiddenCount: 0,
      },
      { zoneKey: 'SECOND_INSPECTION', ordered: true, cards: [], hiddenCount: 3 },
      {
        zoneKey: 'SECOND_WAITING_ROOM',
        ordered: false,
        cards: [
          {
            ownerSeat: 'SECOND',
            card: globalThis.structuredClone(live),
            faceDown: false,
            publiclyRevealed: true,
            orientation: OrientationState.ACTIVE,
          },
        ],
        hiddenCount: 0,
      },
    ],
    live: {
      players: [
        {
          seat: 'FIRST',
          stage: stage(),
          energy: globalThis.structuredClone(energy),
          liveCards: [
            {
              liveToken: 'live-1',
              faceDown: false,
              card: globalThis.structuredClone(live),
              judgmentResult: true,
              scoreModifier: 1,
              requirementReduction: 0,
              requirementModifiers: [{ color: HeartColor.GREEN, countDelta: -2 }],
            },
          ],
          score: 7,
          scoreModifier: 1,
          heartBonuses: [{ color: HeartColor.GRAY, count: 1 }],
          cheerHeartColorReplacement: {
            fromColors: [HeartColor.GRAY, HeartColor.BLUE],
            toColor: HeartColor.GREEN,
          },
        },
        {
          seat: 'SECOND',
          stage: stage(),
          energy: globalThis.structuredClone(energy),
          liveCards: [{ liveToken: 'opponent-live-1', faceDown: true, card: null }],
          score: 0,
          scoreModifier: 0,
          heartBonuses: [],
          cheerHeartColorReplacement: null,
        },
      ],
      winnerSeats: ['FIRST'],
      confirmedSeats: ['SECOND'],
    },
  };
}

function request(kind: AiDecisionRequestV2['window']['kind']): AiDecisionRequestV2 {
  const base = {
    schemaVersion: 2 as const,
    decisionId: 'decision-1',
    contextDigest: 'original-uncompressed-context-digest',
    observation: observation(),
  };
  switch (kind) {
    case 'MULLIGAN':
      return {
        ...base,
        observation: { match: base.observation.match, zoneCounts: base.observation.zoneCounts },
        window: {
          kind,
          minSelections: 0,
          maxSelections: 3,
          candidates: [member, member, live].map((card, index) => ({
            token: `mulligan-${index}`,
            card: globalThis.structuredClone(card),
          })),
        },
      };
    case 'MAIN_ACTION':
      return {
        ...base,
        window: {
          kind,
          minSelections: 1,
          maxSelections: 1,
          candidates: [
            { kind: 'END_MAIN_PHASE', actionToken: 'main-1' },
            {
              kind: 'PLAY_MEMBER_WITH_SINGLE_RELAY',
              actionToken: 'main-2',
              sourceHandToken: 'hand-1',
              targetSlot: SlotPosition.LEFT,
              payment: { modifiedCost: 9, energyCost: 2, relayDiscount: 7 },
            },
            {
              kind: 'ACTIVATE_ABILITY',
              actionToken: 'main-3',
              legality: 'DECLARATION_ONLY',
              sourceSlot: SlotPosition.LEFT,
              abilityText: '完整起动文本；候选仅通过声明检查。',
            },
          ],
        },
      };
    case 'EFFECT_STEP':
      return {
        ...base,
        window: {
          kind,
          minSelections: 1,
          maxSelections: 1,
          sourceCard: globalThis.structuredClone(member),
          sourceCardDisplayCode: member.cardCode,
          controllerSeat: 'FIRST',
          effectText: '完整效果文本',
          stepText: '完整步骤文本',
          candidates: [
            { kind: 'CONFIRM', actionToken: 'effect-1' },
            {
              kind: 'SELECT_CARD',
              actionToken: 'effect-2',
              card: globalThis.structuredClone(member),
              ownerSeat: 'FIRST',
            },
            { kind: 'SELECT_SLOT', actionToken: 'effect-3', targetSlot: SlotPosition.RIGHT },
            { kind: 'SELECT_EFFECT_OPTION', actionToken: 'effect-4', label: '完整选项说明' },
            { kind: 'SKIP', actionToken: 'effect-5' },
          ],
        },
      };
    case 'EFFECT_CARD_SELECTION':
      return {
        ...base,
        window: {
          kind,
          legality: 'DECLARATION_ONLY',
          minSelections: 0,
          maxSelections: 2,
          ordered: true,
          canSkip: true,
          sourceCard: null,
          sourceCardDisplayCode: 'ALREADY-PUBLIC-SOURCE-CODE',
          controllerSeat: 'FIRST',
          effectText: '回收成员和LIVE各至多一张',
          stepText: '选择后的顺序必须保留',
          candidates: [member, member, live].map((card, index) => ({
            cardToken: `multi-${index}`,
            card: globalThis.structuredClone(card),
            ownerSeat: 'FIRST',
          })),
          groups: [
            { candidateCardTokens: ['multi-0', 'multi-1'], minCount: 0, maxCount: 1 },
            { candidateCardTokens: ['multi-2'], minCount: 0, maxCount: 1 },
          ],
          distinctGroupAssignment: true,
          rejectedSelections: [['multi-2', 'multi-0'], []],
        },
      };
    case 'LIVE_ACTION':
      return {
        ...base,
        window: {
          kind,
          minSelections: 1,
          maxSelections: 1,
          candidates: [
            { kind: 'SET_LIVE_CARD', actionToken: 'live-1', sourceHandToken: 'hand-3' },
            {
              kind: 'SELECT_SUCCESS_LIVE',
              actionToken: 'live-2',
              liveToken: 'live-1',
              card: globalThis.structuredClone(live),
            },
            { kind: 'SKIP_SUCCESS_LIVE', actionToken: 'live-3' },
          ],
        },
      };
  }
}

/** Test-only independent reconstruction; the engine continues to validate the original request. */
function reconstruct(input: AiCompactDecisionInput): unknown {
  function expand(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(expand);
    if ('cardRef' in value && typeof value.cardRef === 'string') {
      expect(Object.keys(value)).toEqual(['cardRef']);
      const card = input.cardCatalog[value.cardRef];
      expect(card).toBeDefined();
      return globalThis.structuredClone(card);
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
  }
  return expand(input.request);
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  Object.values(value).forEach(deepFreeze);
  Object.freeze(value);
}

describe('compactAiDecisionRequest', () => {
  it.each<AiDecisionRequestV2['window']['kind']>([
    'MULLIGAN',
    'MAIN_ACTION',
    'EFFECT_STEP',
    'EFFECT_CARD_SELECTION',
    'LIVE_ACTION',
  ])('preserves the complete %s request, all tokens, order, modifiers and choices', (kind) => {
    const source = request(kind);
    const original = globalThis.structuredClone(source);
    deepFreeze(source);
    const compact = compactAiDecisionRequest(source);
    expect(compact.format).toBe('loveca-ai-compact-v1');
    expect(reconstruct(compact)).toStrictEqual(original);
    expect(source).toStrictEqual(original);
    expect(Object.values(compact.cardCatalog)).toStrictEqual([member, live]);
    expect(compact.request.contextDigest).toBe(source.contextDigest);
    expect(compact.request.window.candidates).toHaveLength(source.window.candidates.length);
  });

  it('does not merge same-code cards with different printed values, texts or modifiers', () => {
    const variants: AiCardObservationV2[] = [
      member,
      { ...member, modifierDelta: { ...member.modifierDelta, bladeDelta: 2 } },
      { ...member, modifierDelta: { ...member.modifierDelta, costDelta: -1 } },
      {
        ...member,
        modifierDelta: {
          ...member.modifierDelta,
          heartDeltas: [{ color: HeartColor.GREEN, count: 1 }],
        },
      },
      { ...member, blade: 5 },
      { ...member, cardTextCn: '另一个完整效果文本' },
    ];
    const source: AiDecisionRequestV2 = {
      ...request('MULLIGAN'),
      window: {
        kind: 'MULLIGAN',
        minSelections: 0,
        maxSelections: variants.length,
        candidates: [...variants, globalThis.structuredClone(member)].map((card, index) => ({
          token: `token-${index}`,
          card,
        })),
      },
    };
    const compact = compactAiDecisionRequest(source);
    expect(Object.values(compact.cardCatalog)).toStrictEqual(variants);
    expect(reconstruct(compact)).toStrictEqual(source);
    const refs = compact.request.window.candidates.map((candidate) =>
      'card' in candidate ? candidate.card.cardRef : null
    );
    expect(refs).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c1']);
  });

  it('keeps opponent hidden cards null/count-only and never expands a display-only source code', () => {
    const compact = compactAiDecisionRequest(request('EFFECT_CARD_SELECTION'));
    expect(Object.values(compact.cardCatalog).map((card) => card.cardCode)).toEqual([
      'VISIBLE-MEMBER',
      'VISIBLE-LIVE',
    ]);
    expect(compact.request.observation).toMatchObject({
      opponent: { seat: 'SECOND' },
      live: {
        players: [
          { seat: 'FIRST' },
          {
            seat: 'SECOND',
            liveCards: [{ liveToken: 'opponent-live-1', faceDown: true, card: null }],
          },
        ],
      },
      visibleZones: [
        {
          zoneKey: 'FIRST_INSPECTION',
          cards: [{ card: { cardRef: 'c1' }, publiclyRevealed: false, position: 1 }],
        },
        { zoneKey: 'SECOND_INSPECTION', cards: [], hiddenCount: 3 },
        { zoneKey: 'SECOND_WAITING_ROOM' },
      ],
    });
    expect(compact.request.window).toMatchObject({
      sourceCard: null,
      sourceCardDisplayCode: 'ALREADY-PUBLIC-SOURCE-CODE',
    });
  });

  it('returns detached values and does not retain a directory across requests or seats', () => {
    const source = request('LIVE_ACTION');
    const original = globalThis.structuredClone(source);
    const compact = compactAiDecisionRequest(source);
    Object.assign(compact.cardCatalog.c1!, { cardTextCn: 'changed output' });
    Object.assign(compact.request.observation.match, { viewerSeat: 'SECOND' });
    Object.assign(compact.request.window.candidates[0]!, { actionToken: 'changed-token' });
    expect(source).toStrictEqual(original);

    const next: AiDecisionRequestV2 = {
      ...request('MULLIGAN'),
      window: {
        kind: 'MULLIGAN',
        minSelections: 0,
        maxSelections: 1,
        candidates: [{ token: 'next-token', card: globalThis.structuredClone(live) }],
      },
    };
    Object.assign(next.observation.match, { viewerSeat: 'SECOND' });
    const nextCompact = compactAiDecisionRequest(next);
    expect(nextCompact.cardCatalog).toStrictEqual({ c1: live });
    expect(nextCompact.request.window.candidates).toEqual([
      { token: 'next-token', card: { cardRef: 'c1' } },
    ]);
    Object.assign(next.window.candidates[0]!, { token: 'changed-input-token' });
    expect(nextCompact.request.window.candidates[0]).toMatchObject({ token: 'next-token' });
  });

  it('reduces repeated full snapshots without truncating any model input', () => {
    const source = request('EFFECT_CARD_SELECTION');
    const compact = compactAiDecisionRequest(source);
    const originalBytes = Buffer.byteLength(JSON.stringify(source));
    const compactBytes = Buffer.byteLength(JSON.stringify(compact));
    expect(compactBytes / originalBytes).toBeLessThan(0.4);
    expect(reconstruct(compact)).toStrictEqual(source);
    expect(compactAiDecisionRequest(source)).toStrictEqual(compact);
  });
});
