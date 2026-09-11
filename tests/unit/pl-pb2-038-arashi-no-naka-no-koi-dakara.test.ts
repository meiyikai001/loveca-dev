import { describe, expect, it } from 'vitest';
import {
  createCardInstance,
  createHeartRequirement,
  type LiveCardData,
  type MemberCardData,
} from '../../src/domain/entities/card';
import { createGameState, registerCards, updatePlayer } from '../../src/domain/entities/game';
import { placeCardInSlot, removeCardFromSlot } from '../../src/domain/entities/zone';
import {
  collectLiveModifiers,
  getPlayerLiveScoreModifier,
} from '../../src/domain/rules/live-modifiers';
import { projectPlayerViewState } from '../../src/online/projector';
import {
  CardType,
  FaceState,
  OrientationState,
  SlotPosition as S,
} from '../../src/shared/types/enums';
import { getCardAbilityDefinitionsForCardCode } from '../../src/application/card-effects/definitions/lookup';
import { PL_PB2_038_CONTINUOUS_TWO_MUSE_NON_STACKING_LIVE_SCORE_ABILITY_ID as ABILITY } from '../../src/application/card-effects/ability-ids';

const TEXT =
  '【常时】此卡存在于自己的LIVE卡区或成功LIVE卡区，且自己的舞台上仅存在2名『μ’s』的成员的场合，LIVE的合计分数+1。此效果不会重复。';
const member = (cardCode: string, group = 'μ’s'): MemberCardData => ({
  cardCode,
  name: cardCode,
  groupNames: [group],
  cardType: CardType.MEMBER,
  cost: 1,
  blade: 1,
  hearts: [],
});
const live = (rare: string): LiveCardData => ({
  cardCode: `PL!-pb2-038-${rare}`,
  name: '正因为是暴风雨中的爱恋',
  cardType: CardType.LIVE,
  score: 5,
  requirements: createHeartRequirement({}),
});
const face = { face: FaceState.FACE_UP, orientation: OrientationState.WAITING };
function setup(rare = 'L') {
  let game = registerCards(createGameState('arashi', 'p1', 'P1', 'p2', 'P2'), [
    createCardInstance(member('a'), 'p1', 'a'),
    createCardInstance(member('b'), 'p1', 'b'),
    createCardInstance(member('c'), 'p1', 'c'),
    createCardInstance(live(rare), 'p1', 'live'),
    createCardInstance(live('L'), 'p1', 'success'),
    createCardInstance(live('NEW'), 'p1', 'success2'),
  ]);
  return updatePlayer(game, 'p1', (p) => ({
    ...p,
    memberSlots: placeCardInSlot(
      placeCardInSlot(p.memberSlots, S.LEFT, 'a', face),
      S.CENTER,
      'b',
      face
    ),
    liveZone: {
      ...p.liveZone,
      cardIds: ['live'],
      cardStates: new Map([['live', { ...face, face: FaceState.FACE_DOWN }]]),
    },
  }));
}
const modifiers = (game: ReturnType<typeof setup>) =>
  collectLiveModifiers(game).filter((m) => m.abilityId === ABILITY);
const score = (game: ReturnType<typeof setup>, viewer: string) =>
  projectPlayerViewState(game, viewer).match.liveResult?.scoreModifiers.FIRST;

describe('PL!-pb2-038 分数5「正因为是暴风雨中的爱恋」', () => {
  it.each(['L', 'NEW'])(
    'registers %s with full text and collects a hidden LIVE source without changing public projection',
    (rare) => {
      expect(getCardAbilityDefinitionsForCardCode(`PL!-pb2-038-${rare}`)).toContainEqual(
        expect.objectContaining({
          abilityId: ABILITY,
          baseCardCodes: ['PL!-pb2-038'],
          queued: false,
          implemented: true,
          effectText: TEXT,
        })
      );
      let game = setup(rare);
      expect(modifiers(game)).toHaveLength(1);
      expect(
        getPlayerLiveScoreModifier(game.liveResolution, 'p1', collectLiveModifiers(game))
      ).toBe(1);
      expect(score(game, 'p1')).toBe(1);
      expect(score(game, 'p2')).toBe(0);
      game = updatePlayer(game, 'p1', (p) => ({
        ...p,
        liveZone: { ...p.liveZone, cardStates: new Map([['live', face]]) },
      }));
      expect(score(game, 'p2')).toBe(1);
    }
  );
  it('uses the public success source first and never stacks within or across the two zones', () => {
    let game = updatePlayer(setup(), 'p1', (p) => ({
      ...p,
      successZone: { ...p.successZone, cardIds: ['success', 'success2'] },
    }));
    expect(modifiers(game)).toEqual([
      { kind: 'SCORE', playerId: 'p1', sourceCardId: 'success', abilityId: ABILITY, countDelta: 1 },
    ]);
    expect(score(game, 'p2')).toBe(1);
    game = updatePlayer(game, 'p1', (p) => ({
      ...p,
      successZone: { ...p.successZone, cardIds: [] },
    }));
    expect(score(game, 'p2')).toBe(0);
    expect(score(game, 'p1')).toBe(1);
    game = updatePlayer(game, 'p1', (p) => ({ ...p, liveZone: { ...p.liveZone, cardIds: [] } }));
    expect(modifiers(game)).toEqual([]);
  });
  it('requires exactly two top-level Muse members and recalculates when the stage changes', () => {
    const game = setup();
    expect(
      modifiers(
        updatePlayer(game, 'p1', (p) => ({
          ...p,
          memberSlots: removeCardFromSlot(p.memberSlots, S.LEFT),
        }))
      )
    ).toEqual([]);
    expect(
      modifiers(
        updatePlayer(game, 'p1', (p) => ({
          ...p,
          memberSlots: placeCardInSlot(p.memberSlots, S.RIGHT, 'c', face),
        }))
      )
    ).toEqual([]);
    expect(
      modifiers(registerCards(game, [createCardInstance(member('b', 'Aqours'), 'p1', 'b')]))
    ).toEqual([]);
    expect(getPlayerLiveScoreModifier(game.liveResolution, 'p2', collectLiveModifiers(game))).toBe(
      0
    );
    expect(modifiers(game)).toHaveLength(1);
    expect(game.liveResolution.liveModifiers).toEqual([]);
  });
});
