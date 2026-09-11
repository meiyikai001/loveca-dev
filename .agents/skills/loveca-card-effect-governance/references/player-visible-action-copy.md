# 玩家文案与显示

适用：definition/activated UI 卡文、activeEffect 按钮/选项/步骤提示、图标 token 和卡效标记。数据文件、印刷冲突及三层审计细节见 [数据与工具](data-and-tooling.md)；定时恢复与可见性实现见 [公开与可见性](reveal-and-visibility.md)，只在任务涉及时补读。

## 正文与字段

- `definition.effectText` 使用指定导出 JSON 中对应能力的完整 `cardTextCn` 段落，`activatedUi.text` 直接复用同一源码常量；只规范化换行与整段首尾空白，不缩写、翻译、替换 token 或按相似含义合并。
- 卡牌详情显示卡牌数据正文，不从 definition 反推；治理本地展示不意味着同步生产数据。`activatedUi.title` 可概括操作，但不是正文或事实来源。
- `activeEffect.effectText` 默认为卡文。无交互 confirm-only 若卡文本身有条件/动态计数且结算结果随状态变化，在卡文后追加实时条件状态、满足与否及实际结果；如不追加须说明理由。不把追加的运行时说明写回 definition 原文。
- 无条件效果不追加当前资源数量、结算预告或调试状态。“来源是否仍在舞台/LIVE/原区域”属于引擎检查，不写进玩家字段；需要表达规则无目标时可写“没有可选择的目标。”
- 玩家文本使用中文自然语言，图标 token 原样保留；除明确“查看原卡文”等入口外，不混入日文规则句式。不出现 source、pending、payload、stale、eventId、trigger 等内部术语。

| 字段 | 职责 |
| --- | --- |
| `effectText` / `activatedUi.text` | 完整能力正文；仅 activeEffect 按上述条件追加状态 |
| `activatedUi.title` | 概括本次操作，不替代正文 |
| `stepText` | 当前步骤及必要规则后果 |
| `selectionLabel` | 要选择的对象 |
| `confirmSelectionLabel` / `numericInput.confirmLabel` | 提交后立即发生的游戏动作 |
| `skipSelectionLabel` | 不选/不发动时的真实分支 |
| `selectableOptions[].label` | 可选的规则动作或结果 |

## 按钮、选项与步骤

先查同型 workflow 的稳定文案；同一 family 保持一致，差异来自规则动作。能写动作就不写机械确认词。

| 动作 | 主按钮示例 |
| --- | --- |
| 入手 / 公开入手 | `加入手牌` / `公开并加入手牌` |
| 进入休息室 | `放置入休息室` |
| 主卡组顶 / 底 | `放置于卡组顶` / `放置于卡组底` |
| 多张按选择顺序移动 | `按此顺序放置于卡组顶` / `按此顺序放置于卡组底` |
| 成员登场 / 选登场槽位 | `登场` |
| 成员状态 / 移动槽位 | `变为待机状态` / `变为活跃状态` / `站位变换` |
| 选择卡支付费用 | `支付费用` |
| 选择 Heart/BLADE 结果 | `获得[赤ハート]` / `获得[BLADE]` |
| 无更具体动作的纯确认 | `确认` |
| 公开定时展示 | 无确认按钮 |

selectionLabel 描述对应候选，例如“选择要加入手牌的卡”“按放置顺序选择卡片”。卡组顶/底按钮统一“放置于”；stepText 可根据卡文使用“放回”。不要用“确定分配”“确认选择”“选择”“继续处理”等无具体动作的按钮作为新流程默认。

- 整体可不发动：正向“发动”、跳过“不发动”。可不入手用“不加入”，可不放置用“不放置”；不选会导致全部检视牌进休息室时写“全部放置入休息室”。“取消”只表示撤回未提交的 UI 操作。
- 负向动作只用 `canSkipSelection + skipSelectionLabel`，不再在 selectableOptions 放一个同义负向项；不用默认“不加入”代替“不发动”。
- 固定来源自身作为费用/动作时不制造 `selectableCardIds: [sourceCardId]` 单卡选择；用“发动 / 不发动”，发动时重验来源并处理。
- 多步骤进入下一步时清理旧候选、数量、选项、确认与跳过字段。第一步按钮描述第一步动作，例如先弃后抽应先“放置入休息室”，不提前概括整个效果。
- 精确选1张的 ORDERED_MULTI 保留提交确认；只有步骤显式声明 `autoSubmitSingleSelection` 时才点击即提交，不能从运行时 min=max=1 推断，避免误改费用/公开或动态退化流程。

## 能量费用与 token

- 查 `client/src/lib/cardEffectTokens.ts` 的既有字面量；不要翻译映射 token、用 emoji/手写图像替代或发明括号文本。普通 Heart 与 BLADE HEART/判心是不同 token，如 `[赤ハート]` 与 `[赤ブレード]`。
- 指定导出正文中缺映射的真实 token，应补映射及测试，不能为了渲染替换导出原文。动态玩家字段采用已支持的 token。
- 费用统一 `[E]`：固定/已知动态数量按实际展开，1点“支付[E]”、2点“支付[E][E]”；动态0点使用“支付0个[E]”。未知动态值在 definition 保留指定导出的完整规则表达，不伪造数量。
- 不写“支付1能量”“支付2张活跃能量”“支付1[E]”“支付2个[E]”；重复费用“每支付4个”也应展开 token。固定重复、动态与0点的差别不能由笼统文本替换处理。
- 费用按钮如“支付[E][E]”，不足提示仍说明对应费用，如“当前活跃能量不足，无法支付[E][E]，可以不发动。”
- 特殊能量选择 stepText 为“请选择用于支付[E][E]的活跃能量卡。”，数量按本次费用展开；selectionLabel 为“选择用于支付费用的能量卡”，按钮“支付费用”。不能省掉候选状态。
- `[E]` 不替代实体能量：活跃、放置、返回、叠在成员下或计数仍写“能量”。文案修改不能改变候选、数量、稳定顺序、非法输入或 continuation。

## 检视/公开文字

- 私密检视只让检视者看到牌面；公开明确的选中卡，不因显示便利公开余牌。普通私密检视保留对应选择/跳过后果，无目标时也能看完适用结果。
- Public Reveal Dwell 使用“展示结束后”，描述实际公开张数、卡文相关条件和去向；不写“确认后/继续处理后”。统一显示“本次公开的卡牌”与“公开展示中，即将自动继续”，不渲染选择/确认按钮。
- 私密检视选1仍用“公开并加入手牌”等真实动作；定时展示不能替代前一步真实选择，也不能嵌套既有 public-card-selection/public-effect-choice。

## 桌面与卡效标记

- 当前处理窗口放在桌面中央，来源用费用/分数与卡名，正文完整显示；卡牌选择优先卡图网格与 hover 详情，舞台可发动起动正文可缩字号/加宽但不省略规则文本。
- 自动化标记只作用于前端对局正面牌：卡顶中间约4px点与1px圆角描边，可处理/发动时变亮，不写卡库/权威规则。入口是 `client/src/lib/cardEffectAutomationVisuals.ts`，通用 Card 接收可选 `effectVisualState`。
- 标记默认开启，构建时 `VITE_CARD_EFFECT_VISUAL_MARKERS=false` / `0` / `off` 可关闭。新增能力通过 `implemented: true` 自动接入；只有无 queued/activated definition 的 cost-calculator-only 效果补 supplemental set。
- 自己主要阶段仍有次数的起动能力用独立紫色高亮覆盖自动化蓝框，卡顶点保留；处理效果时暂停该提示，优先来源/目标/选择显示，结束后仍可用则恢复。
- 将来明确要求移除标记时，仅删除 helper、CardEffectMarker、effectVisualState 与 PlayerArea 传参等前端连接，不改变权威规则；本规范不触发主动清理。

## 验证

- 正文修复用 focused test 内独立完整字符串分别精确断言 effectText 与适用的 activatedUi.text；不要只判断相等或包含，不在测试运行时依赖外部导出。
- 操作字段验证关键规则动作的 selectionLabel、主按钮与跳过文本，以及没有重复负向按钮/固定来源假选择。无需给普通装饰文字写快照。
- 涉及费用 formatter/公共文案时覆盖固定1/复数、动态0/1/复数、特殊选择，普通能量动作不误报；仅改一个卡效时测试该卡实际数量与路径。
- 涉及定时/可见性契约时按公开参考验证双方投影、deadline 前未结算、到期一次推进与失效请求；不在每次文案修改时重跑全部恢复/撤销矩阵。
- 触及卡文/token/操作字段运行相关 focused 测试及 `tests/unit/card-effect-tokens.test.ts`、`tests/unit/card-effect-text-governance.test.ts`。仅修改本文时检查文档一致性即可。
