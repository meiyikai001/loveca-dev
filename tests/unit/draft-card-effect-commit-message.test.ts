import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  draftCommitMessage,
  parseDraftArguments,
  runDraft,
} from '../../.agents/skills/loveca-card-effect-governance/scripts/draft-card-effect-commit-message.js';
import {
  loadExportCardGroups,
  selectExportCardGroups,
} from '../../.agents/skills/loveca-card-effect-governance/scripts/export-card-data.js';
import { findRepoRoot } from '../../.agents/skills/loveca-card-effect-governance/scripts/tooling.js';

const temporaryDirectories: string[] = [];
function tempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'loveca-commit-draft-'));
  temporaryDirectories.push(path);
  return path;
}
function member(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cardCode: 'PL!-pb2-011-R',
    rare: 'R',
    cardType: 'MEMBER',
    nameCn: '绚濑绘里',
    nameJp: '絢瀬絵里',
    cost: 2,
    score: null,
    cardTextCn: '【常时】获得[ブレード]。\n\n【自动】抽1张卡。',
    cardTextJp: '日本語のカードテキスト',
    ...overrides,
  };
}
function writeExport(payload: unknown): string {
  const path = join(tempDirectory(), '卡牌 导出.json');
  writeFileSync(path, JSON.stringify(payload));
  return path;
}
function select(payload: unknown) {
  return selectExportCardGroups(payload, ['PL!-pb2-011']);
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('导出卡牌提交说明', () => {
  it('离线读取指定 JSON，完整卡号展开全部罕度，保留完整中文能力段落', () => {
    const path = writeExport([
      member({
        cardCode: 'PL!-pb2-011-P＋',
        rare: 'P＋',
        cardTextCn: ' \r\n【常时】获得[ブレード]。\r\n\r\n【自动】抽1张卡。\r ',
      }),
      member(),
    ]);
    const fetchMock = vi.fn(() => {
      throw new Error('禁止联网');
    });
    vi.stubGlobal('fetch', fetchMock);
    const groups = loadExportCardGroups(path, ['PL!-pb2-011-P+']);
    expect(groups[0]?.prints.map((card) => card.cardCode).sort()).toEqual([
      'PL!-pb2-011-P+',
      'PL!-pb2-011-R',
    ]);
    const result = runDraft([
      '--cards-json',
      path,
      'PL!-pb2-011-P＋',
      '--title=feat(effect): 更新测试卡效',
    ]);
    expect(result).toBe(
      [
        'feat(effect): 更新测试卡效',
        '',
        '新增卡效:',
        '- PL!-pb2-011 费用2「绚濑绘里」：【常时】获得[ブレード]。\n\n【自动】抽1张卡。',
        '',
        '修复bug:',
        '- 【按实际 diff 补充；没有则删除本节】',
        '',
        '通用更新:',
        '- 【按 shared helper/workflow/query/runtime 的实际 diff 补充；没有则删除本节】',
        '',
        '验证:',
        '- focused vitest：【补充 files / tests】',
        '- tsc --noEmit',
        '- git diff --check',
        '',
      ].join('\n')
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path, 'utf8'))[0].rare).toBe('P＋');
  });

  it('基础编号、前缀和完整卡号取并集，按编号稳定排序；同文合并但保留每张卡的类型、名称和费用/分数', () => {
    const cards = [
      member({ cardCode: 'PL!-pb2-015-P', rare: 'P', nameCn: '西木野真姬', cost: 7 }),
      member(),
      member({
        cardCode: 'PL!-pb2-039-L+',
        rare: 'L+',
        cardType: 'LIVE',
        nameCn: '测试LIVE',
        score: 0,
        cost: 99,
      }),
    ];
    const groups = selectExportCardGroups(cards, ['PL!-pb2-', 'PL!-pb2-011', 'PL!-pb2-039-L＋']);
    expect(groups.map((g) => g.baseCardCode)).toEqual([
      'PL!-pb2-011',
      'PL!-pb2-015',
      'PL!-pb2-039',
    ]);
    const message = draftCommitMessage(groups, '标题');
    expect(message.split('\n').filter((line) => line.startsWith('- PL!'))).toEqual([
      '- PL!-pb2-011 费用2「绚濑绘里」、PL!-pb2-015 费用7「西木野真姬」、PL!-pb2-039 分数0「测试LIVE」：【常时】获得[ブレード]。',
    ]);
  });

  it.each([
    '【常时】获得[BLADE]。\n\n【自动】抽1张卡。',
    '【常时】获得[ブレード]！\n\n【自动】抽1张卡。',
    '【常时】获得[ブレード]。\n【自动】抽1张卡。',
    '【常时】获得[ブレード]。\n\n【自动】抽 1张卡。',
  ])('不近似合并 token、标点或内部空白不同的卡文：%s', (cardTextCn) => {
    const groups = selectExportCardGroups(
      [member(), member({ cardCode: 'PL!-pb2-012-R', cardTextCn })],
      ['PL!-pb2-']
    );
    expect(
      draftCommitMessage(groups, '标题')
        .split('\n')
        .filter((line) => line.startsWith('- PL!'))
    ).toHaveLength(2);
    expect(() =>
      select([member(), member({ cardCode: 'PL!-pb2-011-P', rare: 'P', cardTextCn })])
    ).toThrow(/cardTextCn 冲突/);
  });

  it.each([undefined, null, '', '  \r\n ', 'ー－—-', 42])(
    '任一罕度缺中文时拒绝，不能过滤缺失值或退回日文：%s',
    (cardTextCn) => {
      expect(() =>
        select([member(), member({ cardCode: 'PL!-pb2-011-P', rare: 'P', cardTextCn })])
      ).toThrow(/PL!-pb2-011-P.*cardTextCn/);
    }
  );

  it.each([
    [{ nameCn: '另一名称' }, /nameCn 冲突/],
    [{ cost: 9 }, /费用\/分数 冲突/],
    [{ cardType: 'LIVE', score: 2 }, /cardType 冲突/],
  ] as const)('任一罕度元数据冲突均拒绝：%s', (overrides, message) => {
    expect(() =>
      select([member(), member({ cardCode: 'PL!-pb2-011-P', rare: 'P', ...overrides })])
    ).toThrow(message);
  });

  it.each([
    [{ nameCn: null }, /nameCn/],
    [{ nameCn: ' ' }, /nameCn/],
    [{ cost: null }, /cost/],
    [{ cost: '2' }, /cost/],
    [{ cost: -1 }, /cost/],
    [{ cost: 1.5 }, /cost/],
    [{ cardType: 'LIVE', score: null }, /score/],
    [{ cardType: 'ENERGY' }, /cardType/],
    [{ rare: null }, /rare/],
    [{ rare: 'P' }, /rare/],
  ] as const)('拒绝选中卡牌的无效字段：%s', (overrides, message) => {
    expect(() => select([member(overrides)])).toThrow(message);
  });

  it('拒绝归一化后重复的印刷记录', () => {
    expect(() =>
      select([
        member({ cardCode: 'PL!-pb2-011-P+', rare: 'P+' }),
        member({ cardCode: 'PL!-pb2-011-P＋', rare: 'P＋' }),
      ])
    ).toThrow(/重复登记/);
  });

  it('只校验选中编号的卡文与元数据，不因无关无效果卡、能量或错误 rare 阻断本批', () => {
    expect(
      select([
        member(),
        member({ cardCode: 'PL!-pb2-012-R', cardTextCn: null }),
        { cardCode: 'LL-E-001-SD', cardType: 'ENERGY', rare: 'SD' },
        { cardCode: 'PL!SP-bp7-014-N', rare: 'PL!SP-bp7-014-N' },
      ])
    ).toHaveLength(1);
  });

  it.each([
    { scopes: ['PL!-pb2-011', 'UNKNOWN'], message: /UNKNOWN.*没有匹配/ },
    { scopes: [], message: /至少提供/ },
    { scopes: ['  '], message: /范围不能为空/ },
  ])('无匹配范围或空范围不能静默省略：$scopes', ({ scopes, message }) => {
    expect(() => selectExportCardGroups([member()], scopes)).toThrow(message);
  });

  it.each([
    { payload: { data: [member()] } },
    { payload: { 'PL!-pb2-011-R': member() } },
    { payload: [null] },
    { payload: [{}] },
  ])('拒绝 API、旧 DB 或损坏的导出结构', ({ payload }) => {
    expect(() => select(payload)).toThrow(/导出 JSON/);
  });

  it('文件缺失和 JSON 损坏时附带具体路径，无其他来源兜底', () => {
    const path = join(tempDirectory(), '缺失.json');
    expect(() => loadExportCardGroups(path, ['PL!-pb2-011'])).toThrow(path);
    writeFileSync(path, '{');
    expect(() => loadExportCardGroups(path, ['PL!-pb2-011'])).toThrow(/读取导出 JSON 失败/);
  });
});

describe('提交说明 CLI', () => {
  it.each([
    [[], /--cards-json/],
    [['--cards-json', 'cards.json'], /至少提供/],
    [['--cards-json'], /缺少参数值/],
    [['--cards-json='], /缺少参数值/],
    [['--cards-json', '--title', '标题'], /缺少参数值/],
    [['--api-base-url=https:\/\/example.invalid'], /不支持的选项/],
    [['--typo'], /不支持的选项/],
    [['--cards-json=a', '--cards-json=b', 'PL!-pb2-011'], /重复指定/],
    [['--title=一行\n两行'], /单行/],
  ] as const)('先校验 CLI，再读取任何数据：%s', (args, message) => {
    expect(() => runDraft(args)).toThrow(message);
  });

  it('支持两种参数写法，help 无需文件或卡牌范围', () => {
    expect(
      parseDraftArguments(['--cards-json=a.json', 'PL!-pb2-011-P＋', '--title', '标题'])
    ).toEqual({
      help: false,
      cardsJson: 'a.json',
      scopes: ['PL!-pb2-011-P+'],
      title: '标题',
    });
    expect(runDraft(['--help'])).toContain('--cards-json');
  });

  it('仓库根定位不再要求已初始化 llocg_db', () => {
    const root = tempDirectory();
    const child = join(root, 'src/application/card-effects/definitions');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(child, 'index.ts'), '');
    expect(findRepoRoot(child)).toBe(root);
  });

  it('实际 CLI 可在仓库外离线运行，成功完整输出，失败 stderr 非零且不输出半份草稿', () => {
    const directory = tempDirectory();
    const script = fileURLToPath(
      new URL(
        '../../.agents/skills/loveca-card-effect-governance/scripts/draft-card-effect-commit-message.ts',
        import.meta.url
      )
    );
    const tsx = fileURLToPath(import.meta.resolve('tsx'));
    const offline = join(directory, 'offline.mjs');
    writeFileSync(offline, 'globalThis.fetch = () => { throw new Error("禁止联网"); };');
    writeFileSync(join(directory, '卡牌.json'), JSON.stringify([member()]));
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, ['--import', tsx, '--import', offline, script, ...args], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, LOVECA_CARD_API_BASE_URL: 'https://example.invalid' },
      });
    const success = cli('--cards-json', './卡牌.json', 'PL!-pb2-011');
    expect(success.error).toBeUndefined();
    expect(success.status).toBe(0);
    expect(success.stderr).toBe('');
    expect(success.stdout).toBe(
      runDraft(['--cards-json', resolve(directory, '卡牌.json'), 'PL!-pb2-011'])
    );
    writeFileSync(
      join(directory, '卡牌.json'),
      JSON.stringify([member(), member({ cardCode: 'PL!-pb2-012-R', cardTextCn: null })])
    );
    const failure = cli('--cards-json=卡牌.json', 'PL!-pb2-');
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe('');
    expect(failure.stderr).toMatch(/PL!-pb2-012-R.*cardTextCn/);
    const help = cli('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--cards-json');
  });
});
