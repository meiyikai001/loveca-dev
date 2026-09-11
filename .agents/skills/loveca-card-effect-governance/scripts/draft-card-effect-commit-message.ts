import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadExportCardGroups,
  normalizeExportCardCode,
  type ExportCardGroup,
} from './export-card-data.js';

const USAGE = `用法：
  node --import tsx .agents/skills/loveca-card-effect-governance/scripts/draft-card-effect-commit-message.ts \\
    --cards-json <导出 JSON 路径> <基础编号、完整卡号或前缀>... [--title <提交标题>]

只读取显式指定的导出 JSON 数组（cardCode / cardType / nameCn / cardTextCn 等字段）。
按基础编号校验全部罕度；仅完整中文卡文相同的基础编号合并一行。
不联网，不回退到日文卡文、API 或 llocg_db。相对路径以当前工作目录为准。
选项支持 --key value 或 --key=value；--help 显示本说明。`;

export function parseDraftArguments(argv: readonly string[]): {
  readonly help: boolean;
  readonly cardsJson?: string;
  readonly scopes: readonly string[];
  readonly title?: string;
} {
  const scopes: string[] = [];
  const values = new Map<string, string>();
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--help') {
      help = true;
      continue;
    }
    if (!argument.startsWith('-')) {
      const scope = normalizeExportCardCode(argument);
      if (!scope) throw new Error('卡牌范围不能为空。');
      scopes.push(scope);
      continue;
    }
    const separator = argument.indexOf('=');
    const key = separator < 0 ? argument : argument.slice(0, separator);
    if (!['--cards-json', '--title'].includes(key)) {
      throw new Error(`不支持的选项：${key}。使用 --help 查看用法。`);
    }
    if (values.has(key)) throw new Error(`${key} 不能重复指定。`);
    const value = separator < 0 ? argv[++index] : argument.slice(separator + 1);
    if (!value?.trim() || value.startsWith('--')) throw new Error(`${key} 缺少参数值。`);
    if (key === '--title' && /[\r\n]/.test(value)) throw new Error('提交标题必须为单行。');
    values.set(key, value.trim());
  }
  if (!help) {
    if (!values.has('--cards-json')) throw new Error('必须用 --cards-json 指定本批导出 JSON。');
    if (scopes.length === 0) throw new Error('请至少提供一个基础编号、完整卡号或卡号前缀。');
  }
  return { help, cardsJson: values.get('--cards-json'), scopes, title: values.get('--title') };
}

export function draftCommitMessage(groups: readonly ExportCardGroup[], title: string): string {
  const entries = new Map<string, string[]>();
  for (const group of groups) {
    const card = group.representative;
    const descriptors = entries.get(card.effectText) ?? [];
    const stat = card.cardType === 'MEMBER' ? `费用${card.stat}` : `分数${card.stat}`;
    descriptors.push(`${group.baseCardCode} ${stat}「${card.name}」`);
    entries.set(card.effectText, descriptors);
  }
  return [
    title,
    '',
    '新增卡效:',
    ...[...entries].map(([text, descriptors]) => `- ${descriptors.join('、')}：${text}`),
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
  ].join('\n');
}

export function runDraft(argv: readonly string[]): string {
  const { help, cardsJson, scopes, title } = parseDraftArguments(argv);
  if (help) return `${USAGE}\n`;
  const groups = loadExportCardGroups(cardsJson!, scopes);
  return draftCommitMessage(
    groups,
    title ?? `feat(effect): 更新${scopes.length === 1 ? scopes[0] : '本批'}卡效`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(runDraft(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
