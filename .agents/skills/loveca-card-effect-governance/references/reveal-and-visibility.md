# 公开与可见性

适用：检视、公开、休息室/声援选卡移动、定时展示与其恢复/撤销。区分三种生命周期：真实私密检视交互、已公开来源的选卡展示、刚从隐藏变公开的 Public Reveal Dwell；不能互相替代或重复包装。

## 私密检视与公开

- “检视”只让控制者看正面，对手看牌背；只有卡文明示公开的对象才进入 `revealedCardIds`。选择后公开一张时，未选中牌继续私密，不把整个 `inspectionCardIds` 当公开集合。
- `inspectTopCards(..., { reveal: true })` 只建立检视区与可见性，不产生阅读停留，也不延后移动/奖励。卡文“公开并加入手牌”要先建立适用公开展示，再移动，不能直接入手或要求发动方手动确认公开结果。
- 普通“检视N张，可选1张公开入手，余牌进休息室”优先复用 `look-top-select-to-hand` 等 shared workflow。没有目标、不选或条件失败时，也让玩家看到私密检视结果并确认真实后果，如“全部放置入休息室”；不得立即清空检视区。
- 必须整体公开后才能判断的特殊卡可保留薄单卡编排，不把普通检视 family 扩为条件 DSL。direct mill 已经移动的卡可展示本次实际移动集合，不将其错误搬回检视区。

## Public Reveal Dwell

隐藏对象按卡文变成双方公开，且随后会自动结算、移动、奖励或打开下一真实交互时，使用 `src/application/card-effects/runtime/public-reveal-dwell.ts`：

- 展示后只需无输入结算时用 `withPublicRevealDwell`；下一步是真实选卡、选项或槽位交互时用 `createPublicRevealDwellBeforeNextEffect`，到期仅恢复下一交互。
- 只传本次明确公开的 cardIds；不包装已有 public-card-selection、public-effect-choice 自动展示或 queued manual confirm-only。
- 展示中不执行依赖本次公开结果的移动/奖励/pending continuation；之前已合法付出的费用、区域移动和 `ABILITY_USE` 不回滚。恢复后由原 workflow 重验当前区域、目标与卡牌条件。
- GameSession 写权威 deadline 与唯一 generation；推进请求携带当前 deadline/generation，拒绝提前、旧 generation、重复及夹带选择的请求。零公开对象不生成额外 dwell。

## 已公开来源的选卡展示

玩家选择休息室具体卡加入手牌或放在主卡组顶/底/其他指定位置，以及从本次声援公开区确定具体卡移入手牌、卡组顶/底或休息室时，移动前使用 `runtime/public-card-selection-confirmation.ts` 的两阶段生命周期，即使来源与目的地都公开。

- 首次提交只将本次选中的具体卡通过 `revealedCardIds` 展示给双方，不移动、不奖励、不推进 pending。到期恢复原 step/input，由原 workflow 重新校验后移动/奖励/continuation。
- 普通休息室回手默认 `createWaitingRoomToHandEffectState`；grouped/custom 及卡组位置移动显式声明 `publicCardSelectionConfirmation` metadata，复用统一生命周期，不在单卡复制暂停/公开/恢复。
- 固定目标移动、整休息室/整类对象洗回，或只选择目的地而不选具体休息室卡的效果不接入此选择展示。可选零张/空选择不制造空窗口。
- 声援来源显式写 `source: 'REVEALED_CHEER'`；缺省 source 仅保留现有 `WAITING_ROOM` 兼容，不作为新声援路径写法。
- 声援移动目标同时属于当前玩家本次声援 ID、仍在 `resolutionZone.cardIds` 和 `resolutionZone.revealedCardIds` 且 owner 正确。不能以 event-inclusive 历史公开事实作为可移动集合；已移走卡的 CheerEvent 事实保留供条件计数。
- 服务端确定全部声援卡的移动路径也要展示后进入独立结算 step；展示集合与最终可移动集合不完全一致时整体不移动，不悄悄移动剩余子集。

## 共同的定时恢复约束

- 权威时长为 `min(3500ms, 2000ms + (公开张数 - 1) * 300ms)`，由服务端状态保存 deadline。双方 projector 看到相同本次公开 FRONT 集合和 deadline；客户端据此显示剩余时间。
- 不依赖客户端 command timestamp 或单方手动确认；不在服务进程保留长驻 setTimeout。到期任意对局参与者可请求推进，重复请求只结算一次。
- 客户端不显示普通确认按钮，定时推进只请求一次，effect 切换取消旧 timer。重连不重置有效 deadline，旧窗口请求不影响新效果。
- 自动推进不创建独立 undo entry；选卡公开恢复合并回原选卡撤销条目。撤销后不立即再次执行已经过期的自动结算。
- 文案使用玩家语言，描述“展示结束后”的真实后果；不暴露 source、pending、stale 等内部术语。具体字段见 [玩家文案](player-visible-action-copy.md)。

## 回归入口与适用断言

- Public Reveal Dwell：`tests/integration/public-reveal-dwell.test.ts`、`tests/unit/public-reveal-auto-advance-ui.test.ts`。
- 选卡公开：`tests/integration/public-card-selection-confirmation.test.ts`、`tests/unit/public-card-selection-auto-advance-ui.test.ts`，以及对应声援选卡 workflow 测试。
- 普通检视的双方 FRONT/BACK、选中才公开、成功/失败/无目标/短牌库路径；涉及检视余牌进休息室时断言实际集合仅产生一次 grouped `MAIN_DECK -> WAITING_ROOM` 事件。
- deadline 前保留本次展示对象且依赖展示的移动/奖励/continuation 未发生；先前合法费用和能力使用不回退。到期双方均能推进且只结算一次，提前/旧 generation 被拒绝；重连、状态切换和撤销不会复用旧窗口。
- 休息室首次选中后仍在休息室，声援首次选中后仍在处理区；零选择无空弹窗，stale target 不移动。声援路径分别覆盖 HAND/卡组顶/卡组底/WAITING_ROOM，首次提交不记录 turn1、不追加声援、不推进 pending；移出处理区、失去 revealed 或不再属于本次声援时不移动。
- UI 无普通确认按钮，自动请求与撤销合并正确。仅复用既有展示 helper 的普通卡效测试覆盖该卡的接入和后果；修改共享生命周期时才扩展对应通用回归矩阵。
