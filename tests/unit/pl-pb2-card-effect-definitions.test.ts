import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { getCardAbilityDefinitionsForCardCode } from '../../src/application/card-effects/definitions/lookup';

// Independent complete literals from the user-approved export, never read a live API.
const cases = [
  {
    base: 'PL!-pb2-010',
    abilityId: 'PL!-pb2-010:live-start-printemps-activated-stage-members-gain-blade',
    category: 'LIVE_START',
    sourceZone: 'STAGE_MEMBER',
    triggerCondition: 'ON_LIVE_START',
    queued: true,
    observerOnly: undefined,
    perTurnLimit: undefined,
    expectedText:
      '【LIVE开始时】LIVE结束时为止，每有1名存在于自己的舞台的，本回合中因自己的『Printemps』的卡片的效果，从待机状态变为活跃状态的成员，获得[ブレード]。',
  },
  {
    base: 'PL!-pb2-011',
    abilityId: 'PL!-pb2-011:continuous-bibi-member-below-gain-blade',
    category: 'CONTINUOUS',
    sourceZone: 'STAGE_MEMBER',
    triggerCondition: undefined,
    queued: false,
    observerOnly: undefined,
    perTurnLimit: undefined,
    expectedText: '【常时】放置于此成员下方的『BiBi』的成员卡每有1张，获得[ブレード]。',
  },
  {
    base: 'PL!-pb2-011',
    abilityId: 'PL!-pb2-011:auto-own-effect-wait-opponent-stack-bibi-member',
    category: 'AUTO',
    sourceZone: 'STAGE_MEMBER',
    triggerCondition: 'ON_MEMBER_STATE_CHANGED',
    queued: true,
    observerOnly: true,
    perTurnLimit: undefined,
    expectedText:
      '【自动】每当存在于对方的舞台的成员因自己的卡片的效果变为待机状态时，放置于此成员的下方的卡片小于等于2张的场合，将存在于自己的休息室的1张『BiBi』的成员卡放置于此成员的下方。',
  },
  {
    base: 'PL!-pb2-014',
    abilityId: 'PL!-pb2-014:on-enter-reveal-lily-white-live-swap-success-card',
    category: 'ON_ENTER',
    sourceZone: 'PLAYED_MEMBER',
    triggerCondition: 'ON_ENTER_STAGE',
    queued: true,
    observerOnly: undefined,
    perTurnLimit: undefined,
    expectedText:
      '【登场】可以将手牌的1张『lily white』的LIVE卡公开：将存在于自己的成功LIVE卡区的1张卡片加入手牌。如此做时，将因此公开的卡片放置于自己的成功LIVE卡区。',
  },
  {
    base: 'PL!-pb2-015',
    abilityId: 'PL!-pb2-015:auto-bibi-effect-wait-opponent-activate-member-or-energy',
    category: 'AUTO',
    sourceZone: 'STAGE_MEMBER',
    triggerCondition: 'ON_MEMBER_STATE_CHANGED',
    queued: true,
    observerOnly: true,
    perTurnLimit: 1,
    expectedText:
      '【自动】【1回合1次】因自己的『BiBi』的卡片的效果，将存在于对方的舞台的成员变为待机状态时，从以下选择1项。\n\n·将存在于自己的舞台的1名『BiBi』的成员变为活跃状态。\n\n·将2张能量变为活跃状态。',
  },
  {
    base: 'PL!-pb2-016',
    abilityId: 'PL!-pb2-016:live-start-lily-white-success-repeat-choices',
    category: 'LIVE_START',
    sourceZone: 'STAGE_MEMBER',
    triggerCondition: 'ON_LIVE_START',
    queued: true,
    observerOnly: undefined,
    perTurnLimit: undefined,
    expectedText:
      '【LIVE开始时】存在于自己的成功LIVE卡区的『lily white』的卡片每有1张，从以下选择1项。可以重复选择相同的选项。\n\n·存在于自己的舞台的中央区域的成员，LIVE结束时为止，获得[ブレード]。\n\n·将存在于自己的舞台的1名成员变为活跃状态。\n\n·抽1张卡，将1张手牌放置入休息室。',
  },
  {
    base: 'PL!-pb2-023',
    abilityId: 'PL!-pb2-023:continuous-no-success-card-gain-blade',
    category: 'CONTINUOUS',
    sourceZone: 'STAGE_MEMBER',
    triggerCondition: undefined,
    queued: false,
    observerOnly: undefined,
    perTurnLimit: undefined,
    expectedText: '【常时】只要自己的成功LIVE卡区不存在卡片，获得[ブレード]。',
  },
  {
    base: 'PL!-pb2-026',
    abilityId: 'PL!-pb2-026:activated-wait-self-discard-look-top-printemps-member',
    category: 'ACTIVATED',
    sourceZone: 'STAGE_MEMBER',
    triggerCondition: undefined,
    queued: false,
    observerOnly: undefined,
    perTurnLimit: undefined,
    expectedText:
      '【起动】将此成员变为待机状态，将1张手牌放置入休息室：检视自己的卡组顶的3张卡。可以将其中的1张『Printemps』的成员卡公开并加入手牌。其余的放置入休息室。（待机状态的成员持有的[ブレード]，不会使因声援公开的张数增加。）',
  },
] as const;

describe('PL pb2 new ability classification and exact player text', () => {
  it.each(cases)('$abilityId covers every rarity with the complete ability paragraph', (sample) => {
    for (const rarity of ['R', 'P+', 'UNSEEN']) {
      const definitions = getCardAbilityDefinitionsForCardCode(sample.base + '-' + rarity);
      const found = definitions.filter((d) => d.abilityId === sample.abilityId);
      expect(found).toHaveLength(1);
      const definition = found[0]!;
      expect(definition).toMatchObject({
        baseCardCodes: [sample.base],
        category: sample.category,
        sourceZone: sample.sourceZone,
        queued: sample.queued,
        implemented: true,
      });
      expect(definition.cardCodes).toBeUndefined();
      expect(definition.triggerCondition).toBe(sample.triggerCondition);
      expect(definition.observerOnly).toBe(sample.observerOnly);
      expect(definition.perTurnLimit).toBe(sample.perTurnLimit);
      expect(definition.effectText).toBe(sample.expectedText);
      if (sample.category === 'ACTIVATED')
        expect(definition.activatedUi?.text).toBe(sample.expectedText);
    }
  });

  it('011 keeps continuous and triggered abilities independent', () => {
    const definitions = getCardAbilityDefinitionsForCardCode('PL!-pb2-011-UNSEEN');
    expect(definitions).toHaveLength(2);
    expect(new Set(definitions.map((d) => d.abilityId)).size).toBe(2);
  });

  it('026 activated body directly references its definition effectText constant', () => {
    const file = ts.createSourceFile(
      'definitions.ts',
      readFileSync('src/application/card-effects/definitions/index.ts', 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const objects: ts.ObjectLiteralExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) objects.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
    const property = (node: ts.ObjectLiteralExpression, name: string) =>
      node.properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) && p.name.getText(file) === name
      )?.initializer;
    const definition = objects.find(
      (node) =>
        property(node, 'baseCardCodes')?.getText(file).includes('PL!-pb2-026') &&
        property(node, 'activatedUi')
    )!;
    const text = property(definition, 'effectText')!;
    const ui = property(definition, 'activatedUi') as ts.ObjectLiteralExpression;
    const uiText = property(ui, 'text')!;
    expect(ts.isIdentifier(text)).toBe(true);
    expect(ts.isIdentifier(uiText)).toBe(true);
    expect(uiText.getText(file)).toBe(text.getText(file));
  });
});
