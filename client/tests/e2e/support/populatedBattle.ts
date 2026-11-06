import { expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { installVisualApiMocks } from '../../visual/support/mockApp';
import type { PlayerState } from '../../../../src/domain/entities/player';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

export async function openPopulatedBoard(
  page: Page,
  supportCards = false,
  successCount = 3,
  handCount = 5,
  effectsEnabled = false,
  detailText = ''
) {
  await installVisualApiMocks(page, true);
  await page.route('**/site-status.json*', (route) =>
    route.fulfill({ json: { schemaVersion: 1, availability: 'OPEN', maintenance: null } })
  );
  await page.route('**/images/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/static/deck.png')) return route.fulfill({ path: `${root}assets/deck.png` });
    if (path.endsWith('/back.webp')) return route.fulfill({ path: `${root}assets/back.jpg` });
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140"><rect width="100" height="140" fill="#593751"/><path d="M15 70h70M50 35v70" stroke="#f8bade" stroke-width="8"/></svg>',
    });
  });
  await page.addInitScript(
    (enabled) => localStorage.setItem('loveca-card-entrance-enabled', String(enabled)),
    effectsEnabled
  );
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .some((entry) => entry.name.includes('/src/store/gameStore.ts'))
      )
    )
    .toBe(true);
  const fixture = { repoRoot: root, supportCards, successCount, handCount, detailText };
  await page.evaluate(async ({ repoRoot, supportCards, successCount, handCount, detailText }) => {
    const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
    const storePath = resources.find((url) => url.includes('/src/store/gameStore.ts'))!;
    const load = (path: string) => import(`/@fs${repoRoot}${path}.ts`);
    const [
      { useGameStore },
      { createGameState, registerCards, updatePlayer },
      { createCardInstance },
      { placeCardInSlot },
      enums,
    ] = await Promise.all([
      import(storePath),
      load('src/domain/entities/game'),
      load('src/domain/entities/card'),
      load('src/domain/entities/zone'),
      load('src/shared/types/enums'),
    ]);
    const { GamePhase, SubPhase, SlotPosition, OrientationState, FaceState } = enums;
    const active = { orientation: OrientationState.ACTIVE, face: FaceState.FACE_UP };
    const member = {
      cardCode: 'TEST-member',
      name: '成员',
      nameCn: '成员',
      cardType: 'MEMBER',
      cardTextCn: detailText,
      cost: 1,
      blade: 1,
      hearts: [],
    };
    const live = {
      cardCode: 'TEST-live',
      name: 'LIVE',
      nameCn: 'LIVE',
      cardType: 'LIVE',
      score: 1,
      requirements: { colorRequirements: new Map([['PINK', 2]]), totalRequired: 2 },
    };
    const energy = { cardCode: 'TEST-energy', name: '能量', cardType: 'ENERGY' };
    const extraHands = Array.from({ length: Math.max(0, handCount - 5) }, (_, i) => `extra${i}`);
    const extraDecks = handCount > 5 ? Array.from({ length: 8 }, (_, i) => `draw${i}`) : [];
    const cards = ['p1', 'p2'].flatMap((id) => [
      ...[
        'left',
        'center',
        'right',
        'deck',
        'hand1',
        'hand2',
        'hand3',
        'hand4',
        ...extraHands,
        ...extraDecks,
      ].map((suffix) => createCardInstance(member, id, `${id}-${suffix}`)),
      ...['live0', 'live1', 'incoming'].map((suffix) =>
        createCardInstance(live, id, `${id}-${suffix}`)
      ),
      ...(supportCards
        ? [
            ...Array.from({ length: successCount }, (_, index) =>
              createCardInstance(live, id, `${id}-success${index}`)
            ),
            ...Array.from({ length: 12 }, (_, index) =>
              createCardInstance(energy, id, `${id}-energy${index}`)
            ),
          ]
        : []),
    ]);
    let state = registerCards(
      createGameState('card-sizing', 'p1', '测试玩家', 'p2', '对手'),
      cards
    );
    state = {
      ...state,
      turnCount: 3,
      currentPhase: GamePhase.LIVE_SET_PHASE,
      currentSubPhase: SubPhase.LIVE_SET_FIRST_PLAYER,
    };
    for (const id of ['p1', 'p2']) {
      state = updatePlayer(state, id, (player: PlayerState) => ({
        ...player,
        hand: {
          ...player.hand,
          cardIds: ['hand1', 'hand2', 'hand3', 'hand4', 'incoming', ...extraHands].map(
            (s) => `${id}-${s}`
          ),
        },
        mainDeck: {
          ...player.mainDeck,
          cardIds: [...extraDecks.map((s) => `${id}-${s}`), `${id}-deck`],
        },
        ...(supportCards
          ? {
              successZone: {
                ...player.successZone,
                cardIds: Array.from(
                  { length: successCount },
                  (_, index) => `${id}-success${index}`
                ),
              },
              energyZone: {
                ...player.energyZone,
                cardIds: Array.from({ length: 12 }, (_, index) => `${id}-energy${index}`),
                cardStates: new Map(
                  Array.from({ length: 12 }, (_, index) => [
                    `${id}-energy${index}`,
                    {
                      ...active,
                      orientation: index < 7 ? OrientationState.WAITING : OrientationState.ACTIVE,
                    },
                  ])
                ),
              },
            }
          : {}),
        memberSlots: ['left', 'center', 'right'].reduce(
          (slots, slot) =>
            placeCardInSlot(slots, SlotPosition[slot.toUpperCase()], `${id}-${slot}`, {
              ...active,
              orientation:
                slot === 'right' && window.innerWidth >= 768
                  ? OrientationState.WAITING
                  : OrientationState.ACTIVE,
            }),
          player.memberSlots
        ),
        liveZone: {
          ...player.liveZone,
          cardIds: [`${id}-live0`, `${id}-live1`],
          cardStates: new Map([
            [`${id}-live0`, active],
            [`${id}-live1`, { ...active, face: FaceState.FACE_DOWN }],
          ]),
        },
      }));
    }
    useGameStore.getState().createGame('card-sizing', 'p1', '测试玩家', 'p2', '对手');
    useGameStore.getState().gameSession.authorityState = state;
    useGameStore.getState().syncState();
    const [reactModule, domModule, { GameBoard }, { BattleViewportShell }] = await Promise.all([
      import(resources.find((url) => /\/react\.js(?:\?|$)/.test(url))!),
      import(resources.find((url) => /\/react-dom_client\.js(?:\?|$)/.test(url))!),
      import('/src/components/game/GameBoard.tsx'),
      import('/src/components/game/BattleViewportShell.tsx'),
    ]);
    const React = reactModule.default ?? reactModule;
    const dom = domModule.default ?? domModule;
    document.getElementById('root')!.hidden = true;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0';
    document.body.append(host);
    dom
      .createRoot(host)
      .render(React.createElement(BattleViewportShell, null, React.createElement(GameBoard)));
  }, fixture);
  await expect(page.locator('[data-battle-ui-anchor="self-stage-center"]')).toBeVisible();
}
