import { describe, expect, it } from 'vitest';
import { createCardInstance, type MemberCardData } from '../../src/domain/entities/card';
import { createGameState, registerCards, updatePlayer } from '../../src/domain/entities/game';
import {
  addMemberBelowMember,
  addEnergyBelowMember,
  placeCardInSlot,
  removeCardFromSlot,
} from '../../src/domain/entities/zone';
import {
  collectLiveModifiers,
  getMemberEffectiveBladeCount,
} from '../../src/domain/rules/live-modifiers';
import {
  countMemberCardsBelowSourceMember,
  getCardsBelowSourceMember,
} from '../../src/domain/rules/member-below-queries';
import {
  CardType,
  FaceState,
  OrientationState,
  SlotPosition as S,
} from '../../src/shared/types/enums';

const data = (cardCode: string, unitName = 'BiBi'): MemberCardData => ({
  cardCode,
  name: cardCode,
  unitName,
  cardType: CardType.MEMBER,
  cost: 2,
  blade: 1,
  hearts: [],
});
const face = { orientation: OrientationState.WAITING, face: FaceState.FACE_UP };

describe('pb2 Eli / Rin continuous source BLADE', () => {
  it.each(['R', 'NEW'])(
    'counts only BiBi members for Eli %s, all physical cards for the cap and preserves Chisato all-member counting',
    (rare) => {
      const cards = [
        createCardInstance(data(`PL!-pb2-011-${rare}`), 'p1', 'eli'),
        createCardInstance(data('BIBI', '「BiBi」'), 'p1', 'bibi'),
        createCardInstance(data('OTHER', 'Printemps'), 'p1', 'other'),
        createCardInstance(
          { cardCode: 'ENERGY', name: 'e', cardType: CardType.ENERGY },
          'p1',
          'energy'
        ),
      ];
      let game = registerCards(createGameState('below', 'p1', 'P1', 'p2', 'P2'), cards);
      game = updatePlayer(game, 'p1', (p) => ({
        ...p,
        memberSlots: addEnergyBelowMember(
          addMemberBelowMember(
            addMemberBelowMember(
              placeCardInSlot(p.memberSlots, S.CENTER, 'eli', face),
              S.CENTER,
              'bibi'
            ),
            S.CENTER,
            'other'
          ),
          S.CENTER,
          'energy'
        ),
      }));
      expect(getCardsBelowSourceMember(game, 'p1', 'eli')).toEqual(['bibi', 'other', 'energy']);
      expect(countMemberCardsBelowSourceMember(game, 'p1', 'eli')).toBe(2);
      expect(getMemberEffectiveBladeCount(game, 'p1', 'eli')).toBe(2);
      expect(collectLiveModifiers(game)).toContainEqual(
        expect.objectContaining({
          kind: 'BLADE',
          target: 'SOURCE_MEMBER',
          sourceCardId: 'eli',
          countDelta: 1,
        })
      );
      game = registerCards(game, [createCardInstance(data('PL!SP-bp7-003-SEC'), 'p1', 'eli')]);
      expect(getMemberEffectiveBladeCount(game, 'p1', 'eli')).toBe(3);
      game = updatePlayer(game, 'p1', (p) => ({
        ...p,
        memberSlots: removeCardFromSlot(p.memberSlots, S.CENTER),
      }));
      expect(getCardsBelowSourceMember(game, 'p1', 'eli')).toEqual([]);
      expect(collectLiveModifiers(game)).toEqual([]);
    }
  );
  it.each(['N', 'NEW'])(
    'Rin %s dynamically reacts to any success-zone card, including members and energy; waiting does not erase effective blade',
    (rare) => {
      let game = registerCards(createGameState('rin', 'p1', 'P1', 'p2', 'P2'), [
        createCardInstance(
          { ...data(`PL!-pb2-023-${rare}`, 'lily white'), blade: 3, cost: 7 },
          'p1',
          'rin'
        ),
        createCardInstance(data('SUCCESS'), 'p1', 'success'),
        createCardInstance({ cardCode: 'E', name: 'e', cardType: CardType.ENERGY }, 'p1', 'energy'),
      ]);
      game = updatePlayer(game, 'p1', (p) => ({
        ...p,
        memberSlots: placeCardInSlot(p.memberSlots, S.CENTER, 'rin', face),
      }));
      expect(getMemberEffectiveBladeCount(game, 'p1', 'rin')).toBe(4);
      for (const cardId of ['success', 'energy']) {
        game = updatePlayer(game, 'p1', (p) => ({
          ...p,
          successZone: { ...p.successZone, cardIds: [cardId] },
        }));
        expect(getMemberEffectiveBladeCount(game, 'p1', 'rin')).toBe(3);
      }
      game = updatePlayer(game, 'p1', (p) => ({
        ...p,
        successZone: { ...p.successZone, cardIds: [] },
      }));
      expect(getMemberEffectiveBladeCount(game, 'p1', 'rin')).toBe(4);
      game = updatePlayer(game, 'p1', (p) => ({
        ...p,
        memberSlots: removeCardFromSlot(p.memberSlots, S.CENTER),
      }));
      expect(collectLiveModifiers(game)).toEqual([]);
    }
  );
});
