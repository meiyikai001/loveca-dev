# 能量与移动

适用：费用、能量选择/返回、抽弃、成员状态/槽位、检视余牌或 direct mill。复用动作时选择保留规则事件与 continuation 的入口；不要在单卡 workflow 裸改区域数组和权威状态。

## 费用与能量

- 发动费用用 `EffectCostDefinition` 表达并复用 `src/application/effects/effect-costs.ts`：`DISCARD_HAND_TO_WAITING_ROOM`、`TAP_ACTIVE_ENERGY`、`SEND_SOURCE_MEMBER_TO_WAITING_ROOM`、`SET_SOURCE_MEMBER_ORIENTATION`。即时/已选弃手费用分别由 `payImmediateEffectCosts`、`paySelectedDiscardHandCost` 等既有路径处理；需要触发语义时使用相应 wrapper。
- 活跃阶段的自动恢复归 `GameService` 的 `UNTAP_ALL`；普通登场/换手费用由 costCalculator 和通用支付路径处理并记录 `PAY_COST`，不在前端或单卡补规则。`pendingCostPayment` / `CONFIRM_COST_PAYMENT` 是实际特殊能量选择路径的一部分，不是仅供未来保留。
- 能量已有特殊 marker，不再假设所有能量无差异。通用规则在 `src/application/effects/energy-selection.ts`，选择与恢复在 `src/application/card-effects/runtime/energy-operation-selection.ts`。

| 操作 | 候选与数量 | 自动顺序 |
| --- | --- | --- |
| 支付 | ACTIVE，必须足额 | 合法候选的能量区顺序 |
| 活跃 | WAITING；“至多”按实际可处理数量 | 合法候选的能量区顺序 |
| 放在成员下方 / 返回能量卡组 | 能量区全部能量 | WAITING 优先、ACTIVE 其次，各自保留区域顺序 |

只有合法候选多于需要数量、数量大于零且至少一张带特殊 marker 时，打开通用精确选择窗口；候选恰好足额或无特殊能量时自动处理。卡文“成员或能量”仍由玩家选分支，能量分支再由底座决定是否需选具体能量。workflow 不用 `cardIds[0]` 或 `slice` 自行挑牌，不因文案修改改变候选、数量、顺序、非法输入和恢复语义。

- 放置能量复用 `placeEnergyFromDeckToZone`；状态处理复用 `setEnergyOrientation` / `setFirstEnergyCardsOrientation` 等通用入口，显式指定 ACTIVE/WAITING，不改变普通能量阶段规则。
- 卡效返回能量卡组统一走 `runtime/energy-return.ts` 的 `resolveEnergyReturnByCardEffect`，workflow、可选窗口及其他 runtime 不直接调用底层 `moveEnergyZoneCardsToEnergyDeckByCardEffect`。该 helper 原子完成指定移动、离区 marker 清理、一次批量 `ON_ENERGY_MOVED_TO_DECK` 和精确事件的触发入队；发动/不发动、奖励与 continuation 由 workflow 决定。
- 能量费用玩家文本使用 `[E]`，实体能量移动/状态仍写“能量”；字段与动态数量写法见 [玩家文案](player-visible-action-copy.md)。

触及能量契约时覆盖不足/恰好、普通超额顺序、特殊超额精确选择、重复/非法/stale ID 不推进，并断言真实 energyCardIds。能量返回另覆盖一批一事件、cause/来源正确和仅入队一次；支付窗口覆盖实际 `[E]` 展开。测试入口：`tests/unit/energy-selection.test.ts`、`energy-selection-governance.test.ts`、`energy-return.test.ts` 及相关 integration，按变更选取。

## 抽牌、弃手与牌库刷新

- 抽 N 张复用 `src/application/effects/draw.ts` 的 `drawCardsFromMainDeckToHand`，保留逐张刷新语义。开局、阶段、卡效与声援是否抽牌由各 caller 决定；不要在复用时暗改刷新规则。
- 抽 N 弃 M 卡效优先复用 `workflows/shared/draw-then-discard.ts` 的 `startDrawThenDiscardCardsWorkflow` / `finishDrawThenDiscardCardsWorkflow` 组合，包含精确数量选择、弃手事件与 pending continuation。
- 可选弃手由 `runtime/active-effect.ts` 的 `createOptionalDiscardHandToWaitingRoomActiveEffect` 等既有壳创建；多张及过滤条件扩展同类 helper。手牌实际进休息室默认使用 `discardHandCardsToWaitingRoomAndEnqueueTriggers` 或 `discardOneHandCardToWaitingRoomAndEnqueueTriggers`，不能遗漏 `ON_ENTER_WAITING_ROOM`。
- 固定来源自送是费用，不是站位/朝向变化；复用 `SEND_SOURCE_MEMBER_TO_WAITING_ROOM` 及 leave-stage wrapper。费用已付后不能因后续展示或条件失败悄悄回滚。
- 无明确触发需求的底层原语可以保留，但绕开通常的 trigger-safe 路径时说明具体规则理由并覆盖该边界。

测试入口：`tests/unit/draw.test.ts`、`tests/integration/draw-then-discard.test.ts` 和对应弃手/自送 workflow 测试。

## 成员、检视与区域移动

- 成员移动复用 `moveMemberBetweenSlotsAndEnqueueTriggers` 或现行 stage-formation wrapper；方向变化用 state-change trigger wrapper，离场用 leave-stage wrapper。底层 `member-state.ts` 提供动作，不应绕过事件派发。
- 舞台目标用 stage-targets、card selectors 与 `stage-member-target-selection.ts`；区域选择/移动用 `zone-selection.ts` 的 `ZoneCardSelectionConfig` / `moveSelectedCardsFromZone`。休息室登场复用 `playMembersFromWaitingRoomToEmptySlots` 等现有入口，非手牌登场仍以明确来源触发登场能力；移动原语不自行运行新能力。
- 私密检视/公开/入手/余牌清理复用 `look-top.ts` 与现有 shared workflow。检视牌进入休息室必须经统一 inspection-to-waiting helper；事件的 `fromZone=MAIN_DECK`、`toZone=WAITING_ROOM`，同次余牌是一批 `movedCardIds`。不能手写 `waitingRoom.cardIds` 加 `clearInspectionCards` 省掉事件。
- 不经检视的 direct mill 用 `moveTopDeckCardsToWaitingRoomAndEnqueueTriggers`、`moveTopDeckCardsToWaitingRoomWithRefreshAndEnqueueTriggers`或 `enqueueMainDeckCardsEnteredWaitingRoom`。同次实际从主卡组进入休息室的牌是一个事件批次；刷新洗回卡组不算本次移动，原本不刷新的费用不能偷偷改成 WithRefresh。
- 卡文“将1张”按合法目标强制选择；“可以”才保留对应不发动/不选分支。无合法目标按规则结束，不凭 UI 默认跳过改变强制语义。
- 休息室自由选择与声援卡移动还须走 [公开与可见性](reveal-and-visibility.md) 的选择公开生命周期；触及公开路径才读该参考。

`emitGameEvent` / `GameState.eventLog` 保存权威不可变事件事实；EventBus 只用于非权威运行时/调试。成员登场、离场、方向与槽位变化分别保留 `ON_ENTER_STAGE`、`ON_LEAVE_STAGE`、`ON_MEMBER_STATE_CHANGED`、`ON_MEMBER_SLOT_MOVED` 事实；换手离场的 `replacingCardId` 关系用于离场与新成员登场能力的同一顺序窗口。动作 wrapper 产生事件并按统一队列入队，不直接调用新 resolver。测试应同时确认实际区域变化、正确事件批次与入队次数；零移动不误触发。离场相关入口见 `tests/unit/leave-stage-triggers.test.ts`、`tests/unit/leave-stage-event-window.test.ts`。

## 声援动作

普通、追加、重做和 FREE 手动声援共用 `src/application/effects/cheer.ts`：每批公开并记录 CheerEvent 后，立即且仅一次结算该批 DRAW BLADE HEART，再进入适用 ON_CHEER 检查时点或继续当前效果。不能延迟到玩家接受最终判定；追加声援标记 `additional=true` 且不再次触发 ON_CHEER，重做可替换 Heart/Score 贡献但不撤销已抽的牌。

测试入口：`tests/integration/cheer-blade-heart-ordering.test.ts`。声援条件使用历史公开事实，实际移动只用当前合法对象，具体查询语义见 [修正值与查询](modifiers-and-queries.md)。
