import { expect, test, type Page } from '@playwright/test';
import { openPopulatedBoard } from './support/populatedBattle';

const anchor = (page: Page, name: string) => page.locator(`[data-battle-ui-anchor="${name}"]`);

async function selection(page: Page) {
  return page.evaluate(async () => {
    const path = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/src/store/gameStore.ts'))!.name;
    const { useGameStore } = await import(path);
    return useGameStore.getState().ui.selectedCardId;
  });
}

const detail = (page: Page) =>
  page.getByRole('complementary', { name: '成员 卡牌详情', exact: true });

async function boardGeometry(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-battle-ui-anchor]')]
      .filter((element) =>
        /^(self|opponent)-(hand|stage-(left|center|right))$/.test(
          element.dataset.battleUiAnchor ?? ''
        )
      )
      .map((element) => ({
        anchor: element.dataset.battleUiAnchor,
        rect: element.getBoundingClientRect().toJSON(),
      }))
  );
}

async function expectDetailBounds(page: Page) {
  await expect(async () => {
    const panel = (await detail(page).boundingBox())!;
    expect(panel.width).toBeGreaterThanOrEqual(260);
    expect(panel.width).toBeLessThanOrEqual(320);
    expect(panel.y).toBe(12);
    expect(panel.height).toBe(page.viewportSize()!.height - 24);
    const rightEdges = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-battle-ui-anchor^="self-stage-"], [data-battle-ui-anchor^="opponent-stage-"]'
        ),
      ]
        .flatMap((slot) => [slot, ...slot.querySelectorAll<HTMLElement>('[data-card-surface]')])
        .map((element) => element.getBoundingClientRect().right)
    );
    // Only the readability minimum may extend left over the stage's outer edge.
    if (rightEdges.some((right) => panel.x - right < 7.5)) expect(panel.width).toBe(260);
  }).toPass();
}

for (const [width, height] of [
  [1024, 768],
  [1061, 720],
  [1132, 712],
  [1280, 800],
  [1440, 900],
]) {
  test(`touch ${width}x${height}: full-height detail leaves the stage usable without moving it`, async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'tablet-1024x768');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height });
    await openPopulatedBoard(
      page,
      true,
      2,
      7,
      false,
      '[登场]可以从自己的休息室将至多4张不持有BLADE HEART的成员卡按任意顺序放置于卡组底。每有1张因此放置的卡片，将1张能量变为活跃状态。'
    );
    const before = await boardGeometry(page);
    const hand = anchor(page, 'self-hand').locator('[data-card-id="p1-hand1"]');
    await hand.tap({ position: { x: 12, y: 35 } });
    await expect(detail(page)).toBeVisible();
    await expect(detail(page).locator(':scope > div')).toHaveCSS('opacity', '1');
    await expect.poll(() => selection(page)).toBe('p1-hand1');
    await expectDetailBounds(page);
    if (width <= 1061) expect((await detail(page).boundingBox())!.width).toBe(260);
    if (width === 1440) expect((await detail(page).boundingBox())!.width).toBe(320);
    expect(await boardGeometry(page)).toEqual(before);
    const content = detail(page).getByRole('region', { name: '卡牌详情内容' });
    expect(
      await content.evaluate((element) => element.scrollWidth - element.clientWidth)
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath('touch-full-height-detail.png') });

    // Tap the actual waiting card, not just an uncovered corner of its slot.
    await anchor(page, 'self-stage-right').locator('[data-card-id="p1-right"]').tap();
    await expect.poll(() => selection(page)).toBe('p1-right');
    await expect(detail(page).locator('[data-card-id="p1-right"]')).toBeVisible();
    await expectDetailBounds(page);
    await detail(page).getByRole('button', { name: '关闭卡牌详情' }).tap();
    await expect(detail(page)).toHaveCount(0);
    expect(await selection(page)).toBe('p1-right');
    expect(await boardGeometry(page)).toEqual(before);
    await hand.tap({ position: { x: 12, y: 35 } });
    await expect(detail(page)).toBeVisible();
    await detail(page).getByRole('button', { name: '关闭卡牌详情' }).tap();
    await expect(detail(page)).toHaveCount(0);
  });
}

test('touch detail follows window resizing and scrolls long effects inside the panel', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'tablet-1024x768');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1061, height: 720 });
  await openPopulatedBoard(
    page,
    true,
    2,
    7,
    false,
    '[自动]可以从自己的休息室选择成员卡，将其加入手牌。\n'.repeat(60) + '完整卡效结束'
  );
  await anchor(page, 'self-hand')
    .locator('[data-card-id="p1-hand1"]')
    .tap({ position: { x: 12, y: 35 } });
  await expectDetailBounds(page);
  const originalWidth = (await detail(page).boundingBox())!.width;
  await page.setViewportSize({ width: 1280, height: 800 });
  await expectDetailBounds(page);
  expect((await detail(page).boundingBox())!.width).toBeGreaterThan(originalWidth);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expectDetailBounds(page);
  const content = detail(page).getByRole('region', { name: '卡牌详情内容' });
  const box = (await content.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height - 20 }],
  });
  for (let step = 1; step <= 8; step++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height - 20 - step * 35 }],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(80);
  await expect(detail(page).getByRole('button', { name: '关闭卡牌详情' })).toBeInViewport();
  await expect(detail(page).getByText('完整卡效结束', { exact: false })).toBeAttached();
  expect(await selection(page)).toBe('p1-hand1');
  await session.detach();
});

test('touch can drag a member onto the right stage with detail open', async ({ page }, info) => {
  test.skip(info.project.name !== 'tablet-1024x768');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1061, height: 720 });
  await openPopulatedBoard(page, true, 2, 7);
  await page.evaluate(async () => {
    const storePath = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/src/store/gameStore.ts'))!.name;
    const { useGameStore } = await import(storePath);
    const store = useGameStore.getState();
    Object.assign(store.gameSession.state, { currentPhase: 'MAIN_PHASE', currentSubPhase: 'NONE' });
    store.syncState();
  });
  await page.getByRole('button', { name: '规则模式', exact: true }).tap();
  const left = anchor(page, 'self-stage-left').locator('[data-card-id="p1-left"]');
  await left.tap();
  await expect(detail(page)).toBeVisible();
  await expectDetailBounds(page);
  const from = (await left.boundingBox())!;
  const to = (await anchor(page, 'self-stage-right').boundingBox())!;
  const x = from.x + from.width / 2;
  const y = from.y + from.height / 2;
  const targetX = to.x + to.width / 2;
  const targetY = to.y + to.height / 2;
  const session = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    session.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  await touch('touchStart', x, y);
  await touch('touchMove', x + 12, y);
  await touch('touchMove', x + 24, y);
  await expect(page.locator('[data-battle-drag-card]')).toBeVisible();
  for (let step = 1; step <= 10; step++) {
    await touch(
      'touchMove',
      x + 24 + ((targetX - x - 24) * step) / 10,
      y + ((targetY - y) * step) / 10
    );
  }
  await touch('touchEnd', targetX, targetY);
  await expect(anchor(page, 'self-stage-right').locator('[data-card-id="p1-left"]')).toBeVisible();
  await expect(anchor(page, 'self-stage-left').locator('[data-card-id="p1-right"]')).toBeVisible();
  await session.detach();
});

for (const [width, height] of [
  [1061, 720],
  [1366, 768],
]) {
  test(`mouse ${width}x${height}: preview retains hover behavior and size`, async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop-1366x768');
    await page.setViewportSize({ width, height });
    await openPopulatedBoard(page);
    await anchor(page, 'self-hand')
      .locator('[data-card-id="p1-hand1"]')
      .hover({ position: { x: 12, y: 35 } });
    const panel = detail(page);
    await expect(panel).toBeVisible();
    expect((await panel.boundingBox())!.width).toBe(width >= 1280 ? 400 : 380);
    expect((await panel.boundingBox())!.height).toBe(height - 24);
    await expect(panel.getByRole('button', { name: '关闭卡牌详情' })).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(panel).toHaveCount(0);
  });
}

test('portrait phone retains its long-press drawer', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile-390x844');
  await openPopulatedBoard(page);
  const card = anchor(page, 'self-hand').locator('[data-card-id="p1-hand1"]');
  await card.tap({ position: { x: 12, y: 35 } });
  await expect(page.getByRole('dialog', { name: /卡牌详情/ })).toHaveCount(0);
  const box = (await card.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: box.x + 12, y: box.y + 35 }],
  });
  await expect(page.getByRole('dialog', { name: /卡牌详情/ })).toBeVisible();
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.getByRole('button', { name: '关闭卡牌详情' }).tap();
  await expect(page.getByRole('dialog', { name: /卡牌详情/ })).toHaveCount(0);
  await session.detach();
});
