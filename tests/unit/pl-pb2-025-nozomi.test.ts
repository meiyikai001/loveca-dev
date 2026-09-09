import { describe, expect, it } from 'vitest';
import { PL_PB2_025_CONTINUOUS_SUCCESS_LILY_WHITE_GAIN_BLADE_ABILITY_ID as ABILITY } from '../../src/application/card-effects/ability-ids';
import {
  CardAbilityCategory,
  CardAbilitySourceZone,
} from '../../src/application/card-effects/ability-definition-types';
import { getCardAbilityDefinitionsForCardCode } from '../../src/application/card-effects/definitions/lookup';
import { GameService } from '../../src/application/game-service';
import {
  createCardInstance,
  createHeartRequirement,
  type LiveCardData,
  type MemberCardData,
} from '../../src/domain/entities/card';
import {
  createGameState,
  registerCards,
  updatePlayer,
  type GameState,
} from '../../src/domain/entities/game';
import {
  addMemberBelowMember,
  placeCardInSlot,
  removeCardFromSlot,
} from '../../src/domain/entities/zone';
import {
  collectLiveModifiers,
  getMemberEffectiveBladeCount,
} from '../../src/domain/rules/live-modifiers';
import {
  CardType,
  FaceState,
  HeartColor,
  OrientationState,
  SlotPosition,
} from '../../src/shared/types/enums';

const TEXT = '【常时】每有1张存在于自己的成功LIVE卡区的『lily white』的卡片，获得[ブレード]。';
const ACTIVE = { orientation: OrientationState.ACTIVE, face: FaceState.FACE_UP };
const WAITING = { ...ACTIVE, orientation: OrientationState.WAITING };

function nozomi(rare = 'N'): MemberCardData {
  return {
    cardCode: `PL!-pb2-025-${rare}`,
    name: '东条希',
    cardType: CardType.MEMBER,
    cost: 2,
    blade: 1,
    hearts: [{ color: HeartColor.PURPLE, count: 1 }],
    groupNames: ['μ’s'],
    unitName: '「lilywhite」',
  };
}

function member(cardCode: string): MemberCardData {
  return { ...nozomi(), cardCode, name: cardCode, unitName: 'lily white' };
}

function live(cardCode: string, unitName = 'lily white'): LiveCardData {
  return {
    cardCode,
    name: cardCode,
    cardType: CardType.LIVE,
    score: 7,
    requirements: createHeartRequirement({}),
    groupNames: ['μ’s'],
    unitName,
  };
}

function setup(successCardIds: readonly string[] = [], rare = 'N'): GameState {
  const cheerCards = Array.from({ length: 10 }, (_, i) =>
    createCardInstance(member(`cheer-${i}`), 'p1', `cheer-${i}`)
  );
  let game = registerCards(createGameState('pb2-025', 'p1', 'P1', 'p2', 'P2'), [
    createCardInstance(nozomi(rare), 'p1', 'source'),
    createCardInstance(member('other'), 'p1', 'other'),
    createCardInstance(live('ordinary', '「lilywhite」'), 'p1', 'ordinary'),
    createCardInstance(member('success-member'), 'p1', 'success-member'),
    createCardInstance(live('PL!-pb2-041-L'), 'p1', 'romantic'),
    createCardInstance(live('PL!-pb2-041-UNSEEN'), 'p1', 'romantic2'),
    createCardInstance(live('wrong-unit', 'Printemps'), 'p1', 'wrong-unit'),
    createCardInstance(
      { ...live('text-only', 'Printemps'), cardText: '『lily white』的卡片' },
      'p1',
      'text-only'
    ),
    createCardInstance(live('foreign'), 'p2', 'foreign'),
    createCardInstance(live('PL!-pb2-041-L'), 'p2', 'foreign-romantic'),
    ...cheerCards,
  ]);
  game = updatePlayer(game, 'p1', (player) => ({
    ...player,
    memberSlots: placeCardInSlot(player.memberSlots, SlotPosition.CENTER, 'source', ACTIVE),
    successZone: { ...player.successZone, cardIds: successCardIds },
    mainDeck: { ...player.mainDeck, cardIds: cheerCards.map((card) => card.instanceId) },
  }));
  return game;
}

function modifiers(game: GameState) {
  return collectLiveModifiers(game).filter((modifier) => modifier.abilityId === ABILITY);
}

describe('PL!-pb2-025 费用2「东条希」', () => {
  it.each(['N', 'P+', 'P＋', 'UNSEEN'])(
    'covers current and future %s prints with the full continuous paragraph',
    (rare) => {
      expect(getCardAbilityDefinitionsForCardCode(`PL!-pb2-025-${rare}`)).toEqual([
        expect.objectContaining({
          abilityId: ABILITY,
          baseCardCodes: ['PL!-pb2-025'],
          category: CardAbilityCategory.CONTINUOUS,
          sourceZone: CardAbilitySourceZone.STAGE_MEMBER,
          queued: false,
          implemented: true,
          effectText: TEXT,
        }),
      ]);
      const game = setup(['ordinary'], rare);
      expect(getMemberEffectiveBladeCount(game, 'p1', 'source')).toBe(2);
    }
  );

  it.each([
    { cards: [], bonus: 0 },
    { cards: ['ordinary'], bonus: 1 },
    { cards: ['success-member'], bonus: 1 },
    { cards: ['ordinary', 'success-member'], bonus: 2 },
    { cards: ['romantic'], bonus: 2 },
    { cards: ['romantic', 'romantic2', 'ordinary'], bonus: 5 },
  ])('grants $bonus BLADE for $cards without limiting the card type', ({ cards, bonus }) => {
    const game = setup(cards);
    expect(getMemberEffectiveBladeCount(game, 'p1', 'source')).toBe(1 + bonus);
    expect(modifiers(game)).toEqual(
      bonus > 0
        ? [
            {
              kind: 'BLADE',
              target: 'SOURCE_MEMBER',
              playerId: 'p1',
              sourceCardId: 'source',
              countDelta: bonus,
              abilityId: ABILITY,
            },
          ]
        : []
    );
    expect(game.liveResolution.liveModifiers).toEqual([]);
  });

  it('uses structured unit identity and ignores missing, foreign, duplicate and off-zone cards', () => {
    let game = setup([
      'ordinary',
      'ordinary',
      'wrong-unit',
      'text-only',
      'foreign',
      'foreign-romantic',
      'missing',
    ]);
    game = updatePlayer(game, 'p1', (player) => ({
      ...player,
      liveZone: { ...player.liveZone, cardIds: ['romantic'] },
      waitingRoom: { ...player.waitingRoom, cardIds: ['romantic2'] },
      memberSlots: placeCardInSlot(player.memberSlots, SlotPosition.LEFT, 'other', ACTIVE),
    }));
    expect(getMemberEffectiveBladeCount(game, 'p1', 'source')).toBe(2);
    expect(getMemberEffectiveBladeCount(game, 'p1', 'other')).toBe(1);
    expect(modifiers(game)).toHaveLength(1);
  });

  it('recomputes when success cards enter and leave, without persisting a bonus', () => {
    const original = setup(['ordinary']);
    const entered = updatePlayer(original, 'p1', (player) => ({
      ...player,
      successZone: { ...player.successZone, cardIds: ['ordinary', 'romantic'] },
    }));
    const removed = updatePlayer(entered, 'p1', (player) => ({
      ...player,
      successZone: { ...player.successZone, cardIds: [] },
      waitingRoom: { ...player.waitingRoom, cardIds: ['ordinary', 'romantic'] },
    }));
    expect(getMemberEffectiveBladeCount(original, 'p1', 'source')).toBe(2);
    expect(getMemberEffectiveBladeCount(entered, 'p1', 'source')).toBe(4);
    expect(getMemberEffectiveBladeCount(removed, 'p1', 'source')).toBe(1);
    expect(modifiers(removed)).toEqual([]);
    expect(entered.liveResolution.liveModifiers).toEqual([]);
  });

  it('requires an owned top-level source and stops after leaving or becoming a card below', () => {
    const original = setup(['romantic']);
    const left = updatePlayer(original, 'p1', (player) => ({
      ...player,
      memberSlots: removeCardFromSlot(player.memberSlots, SlotPosition.CENTER),
      waitingRoom: { ...player.waitingRoom, cardIds: ['source'] },
    }));
    const below = updatePlayer(original, 'p1', (player) => ({
      ...player,
      memberSlots: addMemberBelowMember(
        placeCardInSlot(
          removeCardFromSlot(player.memberSlots, SlotPosition.CENTER),
          SlotPosition.CENTER,
          'other',
          ACTIVE
        ),
        SlotPosition.CENTER,
        'source'
      ),
    }));
    const foreignSource = registerCards(original, [createCardInstance(nozomi(), 'p2', 'source')]);
    for (const state of [left, below, foreignSource]) {
      expect(modifiers(state)).toEqual([]);
      expect(getMemberEffectiveBladeCount(state, 'p1', 'source')).toBe(1);
      expect(getMemberEffectiveBladeCount(state, 'p1', 'other')).toBe(1);
    }
    const reentered = updatePlayer(left, 'p1', (player) => ({
      ...player,
      memberSlots: placeCardInSlot(player.memberSlots, SlotPosition.RIGHT, 'source', ACTIVE),
      waitingRoom: { ...player.waitingRoom, cardIds: [] },
    }));
    expect(getMemberEffectiveBladeCount(reentered, 'p1', 'source')).toBe(3);
  });

  it.each([
    { state: ACTIVE, cheerCount: 3 },
    { state: WAITING, cheerCount: 0 },
  ])(
    'keeps BLADE when $state.orientation but reveals only $cheerCount cards under the normal cheer rule',
    ({ state, cheerCount }) => {
      const game = updatePlayer(setup(['romantic']), 'p1', (player) => ({
        ...player,
        memberSlots: placeCardInSlot(player.memberSlots, SlotPosition.CENTER, 'source', state),
      }));
      expect(getMemberEffectiveBladeCount(game, 'p1', 'source')).toBe(3);
      const afterCheer = (
        new GameService() as unknown as {
          autoRevealPerformanceCheer(state: GameState, playerId: string): GameState;
        }
      ).autoRevealPerformanceCheer(game, 'p1');
      expect(afterCheer.liveResolution.firstPlayerCheerCardIds).toHaveLength(cheerCount);
      expect(afterCheer.players[0].mainDeck.cardIds).toHaveLength(10 - cheerCount);
      expect(afterCheer.liveResolution.liveModifiers).toEqual([]);
    }
  );
});
