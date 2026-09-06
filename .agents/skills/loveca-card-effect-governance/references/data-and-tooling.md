# 数据与工具

适用：读取导出卡牌、印刷核验、卡文三层审计、卡效提交说明和工具选择。只处理用户指定的数据与卡牌范围；读取本地导出不授权生产操作。

## 导出与规则权威

- 显式记录用户指定的导出 JSON 路径；可从当前任务上下文恢复，不自动挑选“最新文件”。无法确定时询问，不联网或回退到 API、`cards.json`、`cards_cn.json`、Excel、definition 现值或人工翻译。
- 当前格式为顶层数组，字段为 `cardCode`、`rare`、`cardType`、`nameCn`、`cardTextJp`、`cardTextCn`、`cost`、`score`。不得混用旧卡库的 `card_no`/`ability` 或 API 的 snake_case 字段。
- 规则语义核对 `cardTextJp`；展示核对 `cardTextCn`。`MEMBER` 使用 `cost`，`LIVE` 使用 `score`；空值不当作 0，也不用另一数值字段推断类型。能量卡和纯无效果卡不纳入“新增卡效”范围。
- 基础编号是规则身份，完整卡号只是范围入口。卡号与 `rare` 中全角 `＋` 可规范为 `+`；中文正文的标点、空白内部结构和 token 不作同类替换。选中范围检查全部印刷的名称、类型、对应数值及卡文一致性；当前只导出一张印刷也须登记全罕度覆盖。
- 数据、元数据或日文规则缺失/冲突时停止依赖它的卡牌判断，列出缺口；中文缺失或段落映射不明时停止该项展示治理。其他已有确定数据的独立卡牌可继续。提交说明脚本自身采用整次生成失败语义，不能把半份输出冒充完整结果。
- 导出文件保持仓库外只读，不复制全量数据进仓库，不修改或拉取 `llocg_db`。

## 中文正文与三层审计

三层为指定导出 `cardTextCn`、`definition.effectText`、`activatedUi.text`。审计记录文件路径、基础编号/印刷范围、能力段落映射和未解决项。

- 按能力时点拆出完整中文段落再比较，不用整张多能力卡文与一条 definition 比较。相同能力时点有多段时，只在对应段落可精确确定时继续；不能靠关键词猜测映射。
- 只允许 CRLF/LF 和整段首尾空白规范化。`effectText` 使用完整对应段落，`activatedUi.text` 在源码直接引用同一常量；标题可概括操作，不能作为正文来源。
- 用户明确授权的导出笔误修正采用逐项例外：卡号、字段、原文、最终展示、依据和原因。禁止按系列/前缀整体豁免；提交说明与最终展示再次核对。
- token 缺前端映射时，扩展 `client/src/lib/cardEffectTokens.ts` 与相关测试；不得以“等价 token”为由改写导出正文。其他玩家字段职责见 [玩家文案](player-visible-action-copy.md)。
- 修复过正文的样本在 focused test 内用独立完整字符串分别精确断言 `definition.effectText` 与适用的 `activatedUi.text`；不只断言两者相等，不用 `toContain`，不在测试时读外部导出或联网生成期望值。该回归不能代替本次 JSON 三层审计。

## 本地工具

使用已有 Node/tsx 运行，不需要下载依赖。shell 无 Node 时使用可用的 bundled runtime，临时补 PATH；不要把个人绝对路径写进规范。下列命令从仓库根运行。

```bash
# AST + registry 操作文案检查；--list-energy 可列能量文本候选
node --import tsx .agents/skills/loveca-card-effect-governance/scripts/audit-player-visible-copy.ts

# 无需导出文件或已初始化子模块即可查看参数
node --import tsx .agents/skills/loveca-card-effect-governance/scripts/draft-card-effect-commit-message.ts --help

# 用本批指定文件和范围生成事实骨架，示例路径/编号须换成当前任务值
node --import tsx .agents/skills/loveca-card-effect-governance/scripts/draft-card-effect-commit-message.ts --cards-json '<指定导出.json>' '<基础编号或完整卡号或前缀>' --title '更新本批卡效'
```

- 卡效提交说明必须先运行 `draft-card-effect-commit-message.ts`。`--cards-json` 必填，支持相对当前工作目录及绝对路径；卡牌范围取并集、按基础编号排序、展开全部印刷。同文卡只有完整中文正文逐字相同时才合并。
- 草稿脚本纯本地读取，使用 `export-card-data.ts` 做范围与字段校验；不接受 `--api-base-url`，不读取 `LOVECA_CARD_API_BASE_URL`。缺参数、未知选项、空/未命中范围、重复印刷、罕度错误、中文或必要元数据缺失、同编号冲突均整次报错，不输出半份草稿。
- 脚本生成“新增卡效”的事实行及其他章节占位，不识别真实 diff 中的新增/修复边界，也不核验 definition/UI。核对 diff 和最终展示，再补修复、通用更新与真实验证结果；删除不适用章节及未完成占位，不能把模板命令写成已通过的验证。
- `audit-player-visible-copy.ts` 是操作文案检查，不是导出 JSON 三层审计。`tooling.ts` 的仓库根定位无需旧卡库，不表示其所有工具都已迁移数据源。
- 旧 `inventory-card-effect-batch.ts` 仍读取 `llocg_db/json/cards.json`；旧 `audit-activated-ui-card-text.ts` 仍联网读取 API。这两个不是本批默认工具，只有用户另行指定旧数据源及对应只读权限时使用，且仍不得触碰生产管理 API。

## 验证入口

工具行为见 `tests/unit/draft-card-effect-commit-message.test.ts`；卡文/token 契约见 `tests/unit/card-effect-text-governance.test.ts`、`tests/unit/card-effect-tokens.test.ts` 和受影响 workflow 测试。仅改此文档不要求重跑全部工具或读取卡牌数据。
