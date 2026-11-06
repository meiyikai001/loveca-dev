import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { PlayerState } from '../../../src/domain/entities/player';
import { openPopulatedBoard } from './support/populatedBattle';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const anchor = (page: Page, name: string) => page.locator(`[data-battle-ui-anchor="${name}"]`);
const viewport = (page: Page) => anchor(page, 'self-hand').locator('[data-hand-viewport]');

async function arrangeHand(page: Page, count: number, mainPhase = false) {
  await page.evaluate(
    async ({ root, count, mainPhase }) => {
      const storePath = performance
        .getEntriesByType('resource')
        .find((entry) => entry.name.includes('/src/store/gameStore.ts'))!.name;
      const [{ useGameStore }, { updatePlayer }] = await Promise.all([
        import(storePath),
        import(`/@fs${root}src/domain/entities/game.ts`),
      ]);
      const store = useGameStore.getState();
      const all = [
        'hand1',
        'hand2',
        'hand3',
        'hand4',
        'incoming',
        ...Array.from({ length: 25 }, (_, i) => `extra${i}`),
      ].map((id) => `p1-${id}`);
      let state = updatePlayer(store.gameSession.state, 'p1', (player: PlayerState) => ({
        ...player,
        hand: { ...player.hand, cardIds: all.slice(0, count) },
        mainDeck: {
          ...player.mainDeck,
          cardIds: [
            ...all.slice(count),
            ...Array.from({ length: 8 }, (_, i) => `p1-draw${i}`),
            'p1-deck',
          ],
        },
      }));
      if (mainPhase) state = { ...state, currentPhase: 'MAIN_PHASE', currentSubPhase: 'NONE' };
      store.gameSession.authorityState = state;
      store.syncState();
    },
    { root, count, mainPhase }
  );
  await expect(anchor(page, 'self-hand').locator('[data-hand-card-slot]')).toHaveCount(count);
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const hand = document.querySelector<HTMLElement>('[data-battle-ui-anchor="self-hand"]')!;
    const viewport = hand.querySelector<HTMLElement>('[data-hand-viewport]')!;
    const layout = hand.querySelector<HTMLElement>('[data-hand-layout]')!;
    return {
      hand: hand.getBoundingClientRect().toJSON(),
      viewport: viewport.getBoundingClientRect().toJSON(),
      layout: layout.getBoundingClientRect().toJSON(),
      scroll: viewport.scrollLeft,
      maxScroll: viewport.scrollWidth - viewport.clientWidth,
      cards: [...hand.querySelectorAll<HTMLElement>('[data-hand-card-slot]')].map((card) =>
        card.getBoundingClientRect().toJSON()
      ),
      stages: [...document.querySelectorAll<HTMLElement>('[data-battle-ui-anchor]')]
        .filter((element) => /^(self|opponent)-stage-/.test(element.dataset.battleUiAnchor ?? ''))
        .map((element) => element.getBoundingClientRect().toJSON()),
    };
  });
}

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'tablet-1024x768');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1061, height: 720 });
  await openPopulatedBoard(page, true, 2, 30);
});

test('wide touch: small hands approach board center without changing stage or hand height', async ({
  page,
}, info) => {
  const before = await geometry(page);
  for (const count of [0, 1, 5, 6, 7, 9]) {
    await arrangeHand(page, count);
    await expect(page.getByRole('button', { name: '向前浏览手牌' })).toHaveCount(0);
    await expect(async () => {
      const current = await geometry(page);
      expect(current.stages).toEqual(before.stages);
      expect(current.hand).toEqual(before.hand);
      expect(current.maxScroll).toBeLessThanOrEqual(1);
      expect(current.viewport.left).toBe(current.layout.left);
      expect(current.viewport.right).toBe(current.layout.right);
      if (!count) return;
      const first = current.cards[0];
      const last = current.cards.at(-1)!;
      expect(first.left).toBeGreaterThanOrEqual(current.viewport.left + 8);
      expect(last.right).toBeLessThanOrEqual(current.viewport.right - 8);
      const center = (first.left + last.right) / 2;
      const boardCenter = current.hand.left + current.hand.width / 2;
      if (count <= 5) expect(Math.abs(center - boardCenter)).toBeLessThan(1);
      else {
        // Longer hands stop near the right safe boundary, not at the center of
        // the asymmetrically reserved corridor. Never cover the phase controls.
        expect(current.viewport.right - last.right).toBeLessThan(25);
        expect(center).toBeLessThanOrEqual(boardCenter + 1);
      }
      for (let i = 1; i < count; i++) {
        const previous = current.cards[i - 1];
        const card = current.cards[i];
        expect(card.x + card.width / 2 - (previous.x + previous.width / 2)).toBeGreaterThan(32);
      }
    }).toPass();
    if (count === 6) {
      await expect(
        page.locator('[data-battle-card-move], [data-effect-recovery-card]')
      ).toHaveCount(0);
      await page.screenshot({ path: info.outputPath('six-card-touch-hand.png') });
    }
  }
  await arrangeHand(page, 7);
  const live = await geometry(page);
  await arrangeHand(page, 7, true);
  const main = await geometry(page);
  expect(main.cards).toEqual(live.cards);
  // Changing phase controls or opening detail must not shift the card row.
  await anchor(page, 'self-hand')
    .locator('[data-card-id="p1-hand1"]')
    .tap({ position: { x: 12, y: 35 } });
  await expect(page.getByRole('button', { name: '关闭卡牌详情' })).toBeVisible();
  await expect(async () => {
    const after = await geometry(page);
    expect(after.hand).toEqual(main.hand);
    expect(after.stages).toEqual(main.stages);
    expect(after.cards.map((card) => card.x)).toEqual(main.cards.map((card) => card.x));
  }).toPass();
});

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test(`wide touch: overflow transitions retain browsing and new-card notices (${reducedMotion})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const count of [9, 10, 12, 13, 30, 9, 10]) {
      await arrangeHand(page, count);
      if (count === 9) {
        await expect(page.getByRole('button', { name: '向前浏览手牌' })).toHaveCount(0);
        await expect.poll(() => viewport(page).evaluate((element) => element.scrollLeft)).toBe(0);
      } else {
        await expect(page.getByRole('button', { name: '向后浏览手牌' })).toBeDisabled();
        const layout = await geometry(page);
        expect(layout.viewport.left - layout.layout.left).toBe(24);
        expect(layout.layout.right - layout.viewport.right).toBe(24);
        await page.getByRole('button', { name: '向前浏览手牌' }).tap();
        await expect
          .poll(() => viewport(page).evaluate((element) => element.scrollLeft))
          .toBeLessThan(layout.scroll);
        await viewport(page).evaluate((element) => {
          element.scrollLeft = 0;
        });
        await expect(page.getByRole('button', { name: '向前浏览手牌' })).toBeDisabled();
        await viewport(page).evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
        });
        await expect(page.getByRole('button', { name: '向后浏览手牌' })).toBeDisabled();
      }
    }
    await arrangeHand(page, 20, true);
    await page.getByRole('button', { name: '规则模式', exact: true }).tap();
    await viewport(page).evaluate((element) => {
      element.scrollLeft = 0;
    });
    await expect(page.getByRole('button', { name: '向前浏览手牌' })).toBeDisabled();
    const before = await geometry(page);
    await page.getByRole('button', { name: '从主卡组抽一张牌', exact: true }).tap();
    await expect(anchor(page, 'self-hand').locator('[data-hand-card-slot]')).toHaveCount(21);
    await expect(page.getByRole('button', { name: '查看 1 张新手牌' })).toBeVisible();
    expect((await geometry(page)).scroll).toBe(before.scroll);
    await page.getByRole('button', { name: '查看 1 张新手牌' }).tap();
    await expect(page.getByRole('button', { name: '向后浏览手牌' })).toBeDisabled();
    expect(errors).toEqual([]);
  });
}

test('wide touch: large hands can pan and drag a visible card out without moving the stage', async ({
  page,
  context,
}) => {
  await arrangeHand(page, 20, true);
  await page.getByRole('button', { name: '规则模式', exact: true }).tap();
  await viewport(page).evaluate((element) => {
    element.scrollLeft = 0;
  });
  await expect(page.getByRole('button', { name: '向前浏览手牌' })).toBeDisabled();
  const before = await geometry(page);
  const client = await context.newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    client.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  const startX = before.viewport.right - 35;
  const y = before.viewport.y + before.viewport.height / 2;
  await touch('touchStart', startX, y);
  for (let i = 1; i <= 8; i++) await touch('touchMove', startX - i * 20, y);
  await touch('touchEnd', startX - 160, y);
  await expect
    .poll(() => viewport(page).evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(50);
  await expect(page.locator('[data-battle-drag-card]')).toHaveCount(0);
  await viewport(page).evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(page.getByRole('button', { name: '向后浏览手牌' })).toBeDisabled();
  const card = anchor(page, 'self-hand').locator('[data-card-id]').last();
  const id = await card.getAttribute('data-card-id');
  const source = (await card.boundingBox())!;
  const target = (await anchor(page, 'self-waiting-room').boundingBox())!;
  const x = source.x + source.width / 2;
  const startY = source.y + source.height / 2;
  await touch('touchStart', x, startY);
  await touch('touchMove', x, startY - 10);
  await touch('touchMove', x, startY - 20);
  await expect(page.locator('[data-battle-drag-card]')).toBeVisible();
  for (let i = 1; i <= 10; i++) {
    await touch(
      'touchMove',
      x + ((target.x + target.width / 2 - x) * i) / 10,
      startY - 20 + ((target.y + target.height / 2 - startY + 20) * i) / 10
    );
  }
  await touch('touchEnd', target.x + target.width / 2, target.y + target.height / 2);
  await expect(anchor(page, 'self-hand').locator(`[data-card-id="${id}"]`)).toHaveCount(0);
  await expect(anchor(page, 'self-hand').locator('[data-hand-card-slot]')).toHaveCount(19);
  expect((await geometry(page)).stages).toEqual(before.stages);
  await client.detach();
});
