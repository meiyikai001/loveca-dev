# Loveca Battle Agent Guide

本文件给后续接手本项目的 AI / Codex 使用。开始任何开发前，先读本文件，再读最新的 `PROJECT_PROGRESS_TODO.md`。

## 项目定位

- 本项目实现 Loveca 的共享规则引擎、本地调试与对墙打、正式联机、观战、历史回放及赛季玩法；各模块当前边界以 `PROJECT_PROGRESS_TODO.md` 与 `docs/README.md` 所列专题文档 为准。
- 开发持续以“规则正确 + 玩家视角可测”为重点，线上能力的实现与生产验收分别确认。
- 本地测试桌面和正式网页桌面共用 `GameBoard` / `PlayerArea`，不要把测试界面做成另一套分叉 UI。

## 常用入口

- 仓库目录：使用当前 checkout 根目录（可通过 `git rev-parse --show-toplevel` 获取），不依赖作者机器的绝对路径。
- 当前本地测试页面通常在：`http://localhost:5173/`
- 用户通常会在 Codex in-app browser 中自己操作页面测试。如果需要用户测试，直接说明要测什么，不要擅自推进复杂对局。

## 聊天输出约定

- 在聊天更新和最终回复中提到具体卡牌编号时，同时写清费用/分数与卡名。成员卡格式示例：`PL!SP-bp4-008-P` 费用 13「若菜四季」；LIVE 卡格式示例：`PL!-sd1-019-SD` 分数 4「START:DASH!!」。
- 需要提交代码或创建 PR 时，commit message 和 PR title 都用中文。
- 非平凡提交不要只写一行标题。小修可以单行；卡效批次、架构调整、rebase 收束、PR 前清理等提交应使用多行 commit message：标题概括目的，正文说明变更范围、关键实现点、验证命令/结果，以及刻意未处理的本地状态或后续事项。
- 卡效完成状态的主登记册是 `docs/card-effect-reuse-audit/existing_module_map.md`，按基础编号记录完整/部分/同型/partial 状态。每完成一张卡或一个效果段，优先实时更新该登记册，记录基础编号、费用/分数、卡名、同编号罕度覆盖、已实现段、暂未实现段、复用模块与测试文件。

## 卡效批处理文档节奏

连续实现多张卡效时，默认采用“快速卡效批处理模式”，不要每张卡都全量刷新设计类文档。文档节奏要偏硬：先保证卡效登记与测试准确，设计/覆盖/gap 文档只在确有架构变化或批末明确收束时再整理。

必须实时更新：

- `docs/card-effect-reuse-audit/existing_module_map.md`：主登记册，每张卡/每个效果段落地后更新。
- focused tests：对应能力登记、关键结算路径、同编号罕度同步或真实数据形态必须覆盖。

`PROJECT_PROGRESS_TODO.md` 只在当前基线、仍有效缺口或下一步确有变化时更新；不要写逐窗口完成记录、验证流水账或提交说明替代品，已完成工作由 Git 历史和卡效主登记册追溯。

默认暂不随每张卡更新，只有在“批末收束”或确有新边界时才更新：

- `docs/card-effect-framework/card_effect_framework_design.md`
- `docs/card-effect-framework/card_effect_fragment_coverage_matrix.md`
- `docs/card-effect-reuse-audit/effect_module_coverage.md`
- `docs/card-effect-reuse-audit/card_effect_batch_expansions.md`
- `docs/card-effect-reuse-audit/module_gap_list.md`
- `docs/card-effect-reuse-audit/safe_refactor_plan.md`

例外：如果本批引入新抽象、新模块、新事件边界，或改变 resolver / cost calculator / live modifier registry / 同编号罕度同步机制，应在同一批内同步更新相关设计、覆盖和 gap 文档。若只是复用既有模块追加同构卡效，即使连续做 5-10 张，也先保持主登记册与测试准确；等用户明确要求“这批收束/提交”时，再做一次批末摘要式收束，避免全文扫描式重写。

## 测试卡组与卡图资产

- 首页独立的“本地测试对局”入口已于 2026-06-14 移除；后续卡效验证优先使用作者提供的 `pnpm test-env:start` 完整测试环境和云端卡组。
- 测试卡组 YAML 仍保留在 `assets/decks/`，供预设卡组、对墙打默认对手或后续测试资产参考使用。
- 本地测试卡图下载脚本是 `scripts/download-local-test-card-images.mjs`。脚本会自动扫描 `assets/decks/*.yaml` / `*.yml`，从 `llocg_db/json/cards.json` 与 `llocg_db/json/cards_cn.json` 找图片元数据，下载原图到 `assets/card/`，并压缩到 `assets/images/{thumb,medium,large}/`。
- 当前测试服务器仍依赖 `assets/images/` 的本地图片 fallback；未明确切换到完整对象存储图片前，不要删除 `assets/images/`。
- 2026-06-14 起，为了让作者提供的一键测试环境更接近真实体验，曾临时从 `/Users/meiyikai/Desktop/文件/个人/codex/loveca/deck` 的外部 YAML 测试卡组补齐卡图，并让下载脚本支持 `--deck-dir=...`、同基础编号多罕度展开，以及 `P+` / `L+` 等文件名别名。这个补图方案只服务本地/测试服务器显示，不是生产卡图资产方案。
- 生产环境已有独立图片服务器/对象存储提供卡图；卡效实现与验证不要依赖这些临时图片是否存在。提交或上线前必须检查 `assets/card/` 与 `assets/images/` 的 diff，避免把临时补图作为生产资产带入 PR。若生产图片链路正常，临时补图可在上线前从工作树清理，不影响卡效逻辑。
- 预览新增卡组会下载哪些图：

```bash
node scripts/download-local-test-card-images.mjs --dry-run
```

- 实际下载/压缩：

```bash
node scripts/download-local-test-card-images.mjs
```

## 关键架构

- 权威状态与命令处理：`src/application/game-session.ts`
- 低层规则服务：`src/application/game-service.ts`
- 游戏状态实体：`src/domain/entities/game.ts`
- 区域/卡牌状态：`src/domain/entities/zone.ts`
- 费用计算入口：`src/domain/rules/cost-calculator.ts`
- 卡效定义入口：`src/application/card-effects/definitions/index.ts`
- 卡效调度入口：`src/application/card-effect-runner.ts`
- 联机/前端视图投影：`src/online/projector.ts`
- 前端 store：`client/src/store/gameStore.ts`
- 主桌面：`client/src/components/game/GameBoard.tsx`
- 玩家区域：`client/src/components/game/PlayerArea.tsx`

## 当前开发原则

- 默认选择满足当前明确需求的最小模型与最短权威路径。不要因为“以后可能需要”预先增加字段、状态、表、历史版本、缓存、fallback 或重复投影；出现真实第二用例或已确认的运行风险后再扩展。
- 可由固定规格、当前字段、对象存储属性或既有审计日志直接得到的数据，不在业务表重复持久化。新增持久字段必须能说明当前读取者、权威性和无法即时推导的原因。
- 防御性校验集中在外部输入、权限、并发、持久化和领域不变量等真实边界。不要为内部不可达状态层层兜底；若确有故障模式需要保护，应同时给出具体失败场景与 focused test。
- 简单功能先区分“长期配置”“对局运行状态”和“临时 UI 状态”：只持久化当前业务流程确实会再次读取、且无法从既有权威状态得到的数据。一次选择弹窗的候选、展示顺序、刷新稳定性、曝光证明等默认属于临时 UI 状态；没有明确产品、合规或运营审计需求时，不得为其新增 offer / history / audit 表、证明字段或消费状态机。
- 新增表或字段前必须逐项回答：当前读取者是谁、缺少它会导致哪个已确认流程失败、为什么不能复用现有字段或即时计算。任一项没有具体答案就先不加。尤其是尚未生产运行的功能，不得为了假设中的迁移、兼容、作弊、防重放或审计风险预建数据模型。
- 用户要求“可配置一个数值并改变交互”时，默认先实现为“一个配置字段 + 既有运行状态 + 最小输入校验”；不要未经需求把它扩展成候选批次、随机证明、曝光指标、历史追踪或多阶段协议。
- 规则状态必须通过 `GameSession` / `GameService` / command 层改变，不要让 React 组件直接改权威状态。
- 不要在 React 组件里硬写具体卡效。
- 不要在 action handler 里散落具体卡效。
- 具体卡效定义层集中在 `src/application/card-effects/definitions/index.ts`；具体卡牌流程与同型 family 分别放在 `src/application/card-effects/workflows/cards/` 和 `workflows/shared/`，原子动作与 activeEffect/pending runtime 放在 `src/application/card-effects/runtime/`。`card-effect-runner.ts` 的完整卡效 fallback 已清空，当前只保留调度、生命周期、registry 注册及尚未迁出的 matcher / relay / trigger 条件胶水；不要把具体 resolver 写回 runner。
- 新增卡效前先在 `CARD_ABILITY_DEFINITIONS` 中按规则分类登记，不要先写单卡散逻辑。
- 卡牌领域不变量：同一“去掉罕度后缀的基础编号”下，各罕度的卡牌类型与完整卡效相同；罕度后缀不是效果边界。卡效 definition、workflow gate、continuous registry、cost/modifier 查询一律按基础编号覆盖，不得把 `cardCodes` 当作“防止尚未发现的罕度自动获得效果”的保险丝，也不得硬编码 `cardCode === '...-P'`。BP7 默认且必须使用 `baseCardCodes`；公开 API / Excel 当前只出现一个具体罕度，只是印刷数据事实，不缩小规则覆盖。
- 新增卡效时仍要用 `llocg_db/json/cards.json`、公开玩家 API 或最新 Excel 核对卡牌类型、日文卡文与当前公开罕度；本地 `cards.json` 缺失或只有 API/Excel 数据，不构成 exact `cardCodes` 登记理由。`existing_module_map.md` 应以基础编号登记覆盖范围，可另注“当前公开版本为某罕度”。罕度同步测试应锁定基础编号覆盖，未知罕度出现时无需再追加 definition。
- 需要隐藏信息时，以 `projector` / visibility / inspection context 控制前端可见性。
- 本地测试和正式网页桌面应尽量复用同一套组件和命令，不做“双轨 UI”。
- 自动费用、撤销、检视区、效果弹窗等交互应以玩家视角自然为优先，但底层仍要记录可审计动作。
- 需要按左/中/右区域限定触发或适用的能力，优先在 `CARD_ABILITY_DEFINITIONS.requiredSourceSlots` 声明条件，并由触发入队阶段写入/检查 `PendingAbilityState.sourceSlot`；不要在单卡 resolver 中散落硬编码槽位判断。

## 测试约定

- 自动化测试优先验证规则不变量、权威状态变化、持久化结果、接口契约和完整用户操作结果；不要为了提高覆盖数字重复验证同一条简单分支。
- 前端测试不要仅为锁定普通界面文案而添加 `getByText` / `toHaveText` 断言。按钮、表单标签等可访问名称可以用于定位和执行操作；只有文案本身属于明确产品契约、规则信息或关键错误指引时，才针对文字做窄断言。
- E2E 应以操作是否成功、数据是否正确落地以及后续流程是否可继续作为主要结束条件，不要用成功提示、栏目标题或说明句出现来替代结果验证。视觉层级和文案质量由针对性截图审查或人工体验评估覆盖。

## 后向兼容与停机迁移原则

- 业务逻辑和运行时读取路径默认不做后向兼容。不要保留旧字段、旧凭据、旧 token、旧协议或旧状态的 fallback、dual-read、登录时懒迁移等兼容分支。
- 旧数据与旧格式的兼容责任全部属于停机更新迁移。发布时应先停止旧版本及相关写入任务，完成备份、dry-run、迁移、结果校验，再部署只接受新格式的新版本；无法无损转换的数据必须在迁移报告中明确失效、重置或人工恢复策略。
- 若已有需求明确要求长期读取历史归档或继续支持公开外部协议，应在实现前指出它与本原则的冲突并由用户决定；未经明确授权，不得自行在业务路径中增加后向兼容。
- 当前只有已经明确审计的窄例外，不得据此扩散兼容分支：早期 authority checkpoint 缺少 `manualOperationMode` 时，只在历史回放或服务端可记录对墙打恢复的复水边界规范化为 `FREE`；旧 BLADE / HEART modifier 只在 authority checkpoint 复水边界按冻结的 abilityId 审计表迁移，未知、缺字段或冲突形状必须拒绝；历史记录规范路径是 `/api/battle/match-records...`，旧 `/api/online/match-records...` 只作为已公开协议的临时 alias。这些例外都不允许 live session/command 路径 dual-read，也不豁免其他旧 payload 的停机迁移。

## 卡效分类约定

- `CONTINUOUS`（常时）：不进效果队列，由对应计算层读取持续修正，例如声援张数、分数、必要 Heart 修正等。
- `ON_ENTER`（登场）：来源为刚登场成员，触发 `ON_ENTER_STAGE`，必须进入待处理效果队列。
- `ACTIVATED`（起动）：来源为舞台成员，由玩家在合法时点主动点击；费用、次数限制和目标选择在命令层/runner 校验。
- `LIVE_START`（LIVE开始）：来源可以是舞台成员或当前 LIVE 区的 LIVE 卡，触发 `ON_LIVE_START`，必须进入 LIVE 开始效果队列，由玩家选择同一时点顺序。
- `LIVE_SUCCESS`（LIVE成功）：来源为成功的 LIVE 卡或满足条件的卡，必须在对应 Live 成功后才进入 LIVE 成功效果队列。
- `AUTO`（自动）：其他诱发型自动能力按具体 `TriggerCondition` 入队，不应伪装成常时或结算时静默修正。

## 卡效步骤约定

- “可以将 N 张手牌放置入休息室：……”属于通用发动代价/费用步骤，不是具体卡牌特例。
- 当前 N=1 的可选手牌弃置步骤优先使用 `src/application/card-effects/runtime/active-effect.ts` 中的 `createOptionalDiscardHandToWaitingRoomActiveEffect` 创建选择步骤；实际移动优先走会补 `ON_ENTER_WAITING_ROOM` 的 trigger-safe wrapper，只有明确不需要触发语义的底层费用原语才直接调用 `src/application/effects/effect-costs.ts`。
- 卡效发动费用应优先登记/执行为通用 `EffectCostDefinition`，当前已覆盖 `DISCARD_HAND_TO_WAITING_ROOM`、`TAP_ACTIVE_ENERGY`、`SEND_SOURCE_MEMBER_TO_WAITING_ROOM`、`SET_SOURCE_MEMBER_ORIENTATION`。新增 `[E]`、弃手、自送休息室、自身待机/活跃等费用时，先扩展/复用 `src/application/effects/effect-costs.ts` 的 `payImmediateEffectCosts` 或 `paySelectedDiscardHandCost`，不要在单张卡里手写横置能量、移动手牌、清空成员槽位或改变来源成员状态。
- 这类步骤的选择区文案应明确为“请选择要放置入休息室的卡牌”，跳过按钮应为“不发动”，不要写成“请选择要处理的卡牌”或“不加入”。
- 后续支持 N>1、指定名称/颜色/类型的手牌弃置时，应扩展同一个步骤 helper，而不是在单张卡效果里临时写 UI 文案和移动逻辑。
- “检视卡组顶 N 张 -> 选择其中若干张 -> 可选公开 -> 加入手牌 -> 其余放置入休息室”也是通用步骤；当前基础区域操作已落在 `src/application/effects/look-top.ts`，不要只为 `PL!-sd1-004-SD`、`PL!-sd1-015-SD` 或 `PL!-sd1-019-SD` 单独写检视/清理/移动流程。
- “抽 N 张牌”优先复用 `src/application/effects/draw.ts` 的 `drawCardsFromMainDeckToHand`，该 helper 只表达“主卡组顶 -> 手牌”及逐张刷新语义。卡效抽牌与 `effects/cheer.ts` 中每批声援的 DRAW BLADE HEART 规则处理共用该移动原语；开局、阶段和其他 LIVE 规则是否抽牌仍由各自 caller 决定。涉及牌库为空后的刷新处理时，应先确认要保持的规则语义，不要悄悄改变既有流程。
- “抽 N 张后弃 M 张手牌”作为卡效步骤时，优先复用 `src/application/card-effects/workflows/shared/draw-then-discard.ts` 的 `startDrawThenDiscardCardsWorkflow` / `finishDrawThenDiscardCardsWorkflow`，由 shared workflow 组合统一抽牌、精确数量选择、手牌进休息室事件 wrapper 与 pending continuation。`PL!SP-bp4-008-P` 费用 13「若菜四季」左侧登场是 F02 样本之一；不要复制单卡流程或把旧壳写回 runner。
- 能量区卡效步骤优先复用 `src/application/effects/energy.ts`。从能量卡组放置能量到能量区使用 `placeEnergyFromDeckToZone`；将能量变为待机/活跃使用 `setEnergyOrientation` / `setFirstEnergyCardsOrientation`。这些 helper 明确接收目标方向状态；`PL!SP-PR-004-PR` 费用 4「唐 可可」使用它从能量卡组顶放置 1 张待机能量，`PL!SP-bp4-008-P` 费用 13「若菜四季」右侧登场使用它将最多 2 张待机能量变为活跃，不改变普通能量阶段默认活跃放置逻辑。
- 能量操作统一复用 `src/application/effects/energy-selection.ts`：支付只取活跃能量，活跃只取待机能量；放到成员下方或返回能量卡组时自动处理按待机优先、活跃其次。候选多于所需数量且有特殊 marker 时打开通用精确选择窗口，否则按该操作的稳定顺序自动处理。成员/能量分支选择后，能量分支也必须经过同一选择底座。
- “从某区域按条件选择卡 -> 移动到目标区域”属于通用目标选择/移动步骤。当前已由 `src/application/effects/zone-selection.ts` 的 `ZoneCardSelectionConfig` / `moveSelectedCardsFromZone` 覆盖 `WAITING_ROOM -> HAND` 的单选路径，并由 `src/application/effects/card-selectors.ts` 提供 `typeIs` / `groupIs` / `unitIs` / `unitAliasIs` / `unitAliasOrTextAliasIs` / `costLte` / `costGte` / `cardNameIs` / `cardNameAliasIs` / `and` 等最小 selector；新增从休息室回收成员/LIVE、按费用/团体/小组/名称筛选等效果时，优先扩展这个底座，不要在单张卡里重复写移出休息室和加入手牌。小组名条件默认使用 `unitAliasIs` 匹配真实 `unitName`，当前别名覆盖 `Cerise Bouquet`/`スリーズブーケ`、`DOLLCHESTRA`、`Mira-Cra Park!`/`みらくらぱーく！`/`みらくらぱーく!`、`EdelNote`；只有需要处理“所有领域中此卡视为……”等文本身份时，才使用 `unitAliasOrTextAliasIs`。成员名条件默认优先用 `cardNameAliasIs`，当前按卡库常见角色覆盖中日名、空白/中点差异与组合卡 `&` 分隔组件；需要严格卡面名完全一致时才用 `cardNameIs`。
- “按区域/选择器/来源状态查询条件”已由 `src/application/effects/conditions.ts` 起步：当前只提供纯函数 query，不做 AST、不做声明式 steps。已覆盖区域卡牌计数、selector 计数与阈值、成功 LIVE 数、舞台成员数、舞台成员存在性、其他舞台成员、LIVE 区排除来源卡计数，以及来源成员有效 BLADE 阈值查询；`PL!-sd1-009-SD`、`PL!-sd1-022-SD`、`PL!HS-bp5-019-L`、`PL!HS-bp2-022-L+`、`PL!HS-pb1-009-R`、`PL!HS-sd1-006-SD`、`PL!HS-bp6-001`、`PL!HS-bp6-031-L`、`PL!HS-bp1-006-P` 等条件计数已开始复用该层。
- “从因声援公开的卡中选择并移动”优先复用 `src/application/effects/cheer-selection.ts`。移动目标必须取本次声援 ID 与当前 `resolutionZone.cardIds` / `revealedCardIds` 的交集；只判断本次声援曾公开过哪些卡时，必须改用该模块的 event-inclusive 查询，不能把历史条件事实与当前可移动目标混用。涉及声援卡 BLADE HEART 的颜色、ALL 或其他可被持续效果修改的信息时，先通过 `selectCurrentLiveRevealedCheerCardsWithEffectiveBladeHearts` 取得逐卡有效判心；颜色并集复用 `collectCurrentLiveRevealedCheerBladeHeartColors`，不同卡分别覆盖指定颜色复用 `evaluateDistinctCheerCardsCoverHeartColors`，其他条件从逐卡结果做窄聚合。除非卡文明示参照原本/印刷信息，不得直接读取 `card.data.bladeHearts` 或对声援卡使用印刷 selector 代替有效值；`hasAllBladeHeart()` 等印刷 selector 仍可用于成功 LIVE 卡区等未受本次声援改色影响的静态区域。固定颜色列表必须显式维护，不能因 `HeartColor` 新增 GRAY/ORANGE 等枚举值自动扩大卡文范围。普通、追加、重做与手动声援都必须复用 `src/application/effects/cheer.ts`；该入口每批先写入 `CheerEvent`、立即且仅一次结算该批 DRAW BLADE HEART，之后才进入适用的 `ON_CHEER` 检查时点或继续当前卡效。追加声援写入 `additional=true` 但不二次触发 `ON_CHEER`；重做声援可替换原 Heart/Score 贡献，不得撤销原批已完成的抽牌。后续放回卡组底等效果继续扩展同一入口，不要重新扫描整个解决区。
- “按条件选择舞台成员 -> 改变成员状态”已由 `src/application/effects/stage-member-target-selection.ts` 起步：用 `stage-targets.ts` + `card-selectors.ts` 生成候选 active effect，并在结算时调用 `setMemberOrientation`。新增选择自己/对方舞台成员并变为待机/活跃的效果时，优先复用该配置入口。
- “成员变为待机/活跃”与“站位变换”作为卡效步骤时，优先复用 `src/application/effects/member-state.ts` 的 `setMemberOrientation` / `moveMemberBetweenSlots`。普通规则流程里的自由横置、拖拽、手动区域移动仍归 `GameSession` / action handler / `zone-operations.ts`，不要为了卡效抽象反向改写桌面规则流程。
- 事件层已开始向 `GameState.eventLog` 收口：`emitGameEvent` 是权威不可变事件流入口，`EventBus` 只保留作非权威运行时/调试工具。当前普通 `PLAY_MEMBER` 会写入 `ON_ENTER_STAGE`；`member-state.ts`、普通 `TAP_MEMBER` 与活跃阶段重置已在成员方向变化时写入 `ON_MEMBER_STATE_CHANGED`，成员槽位移动/交换会写入 `ON_MEMBER_SLOT_MOVED`；卡效从休息室登场会写入 `ON_ENTER_STAGE`；舞台成员进休息室、换手替换离场、自送费用会写入 `ON_LEAVE_STAGE`；LIVE 翻开进入 LIVE 开始检查时机会写入 `ON_LIVE_START`；LIVE 成功效果窗口会写入 `ON_LIVE_SUCCESS`；自动/手动/追加声援会写入 `ON_CHEER`。`enqueueTriggeredCardEffects` 已消费 `ON_ENTER_STAGE`、`ON_MEMBER_STATE_CHANGED`、`ON_MEMBER_SLOT_MOVED`、`ON_LEAVE_STAGE`、`ON_LIVE_START`、`ON_LIVE_SUCCESS` 与 `ON_CHEER` 事件流，仍保留旧 fallback；`ON_CHEER` 会跳过追加声援事件以避免递归；`PL!N-bp4-018-N` 与 `PL!-pb1-015` 是成员状态变化 AUTO proving path，`PL!SP-bp4-011-P` 费用 7「鬼冢冬毬」是成员移动 AUTO proving path。
- “将此成员从舞台放置入休息室”作为发动费用时，仍优先走 `src/application/effects/effect-costs.ts` 的 `SEND_SOURCE_MEMBER_TO_WAITING_ROOM`；不要和 S01/S02/S05 的状态/站位步骤混成同一个概念。
- 若效果文本写“公开并加入手牌”，必须先把被选牌加入 `inspectionZone.revealedCardIds` 并接入 Public Reveal Dwell，展示结束后再移动到手牌；不能直接加入手牌，也不能要求发动方手动确认公开结果。
- 若效果文本写“将 1 张加入手牌”而不是“可以将 1 张加入手牌”，选择阶段应强制选择；只有没有合法目标时才允许不选。

## 卡效高频场景底座

2026-06-12 已对 `llocg_db/json/cards_cn.json` 全量 2032 张卡做过一次只读统计，其中 1381 张有中文效果文本。高频动作包括：`手牌放置入休息室` 340 次、`检视自己卡组顶` 154 次、`公开并加入手牌` 74 次、`加入手牌` 384 次、`其余的卡片放置入休息室` 162 次、`从自己的休息室...加入手牌` 182 次、`将此成员从舞台放置入休息室` 60 次、`[E]` 费用 180 次、`LIVE开始时` 397 次、`LIVE成功时` 45 次、`分数+1/＋１` 约 131 次、`必要HEART减少` 18 次。

因此后续优先抽象这些共性场景：

- 时点与队列：`ON_ENTER`、`ACTIVATED`、`LIVE_START`、`LIVE_SUCCESS`、`AUTO` 按规则分类登记；同一时点多效果必须走待处理队列/顺序选择。
- 同一队列中玩家手动点选“无需选择对象/无需支付/无需决定”的 pending ability 时，优先走通用 confirm-only active effect：只展示来源卡、效果文本和“继续处理”按钮，确认后才真正 resolve；玩家点“顺序发动”时不逐个弹此确认壳。
- 发动费用/代价：手牌放置入休息室、公开手牌、支付能量、此成员从舞台放置入休息室都应是可复用步骤。
- 检视/公开/移动：私密检视、公开翻牌、选择目标、公开被选目标、加入手牌、其余入休息室、放回卡组顶/排序应拆成可组合步骤。
- 区域检索：从休息室按类型、费用、团体、名称等筛选加入手牌应共用筛选与移动逻辑。
- LIVE 修正：加 Heart、加分、加声援张数、增加/减少必要 Heart 等都应进入 LIVE 自动判定流水线，而不是在 UI 手填结果里静默处理。
- Live 修正统一入口为 `domain/rules/live-modifiers.ts`。结算读取使用 `collectLiveModifiers` 及相关 getter；新增“Live 结束前”临时修正应通过 `addLiveModifier` / `replaceLiveModifier` 写入 `liveResolution.liveModifiers` 的 `SCORE` / `HEART` / `BLADE` / `REQUIREMENT` modifier；常时修正（如 `PL!-sd1-001-SD` 加声援张数）不写入状态，由 continuous modifier registry 按当前场面动态收集。旧的 `playerScoreBonuses`、`playerHeartBonuses`、`liveRequirementReductions`、`liveRequirementModifiers` 只作为兼容投影保留，不作为新增逻辑的主写入路径。
- HEART 作用域只能按卡文语义决定：“此成员获得”或只强化能力来源自身使用 `SOURCE_MEMBER`；“选择／指定成员获得”使用 `TARGET_MEMBER`，即使候选允许选择来源实例自身，也必须分别记录真实 `sourceCardId` 与 `targetMemberCardId`；卡文受益者是玩家整体而非某名成员时使用 `PLAYER`。不得根据来源卡类型、所在区域、两个 ID 是否相等或字段缺失推断 scope，也不得用 scope 反推持续方式。生产 workflow 与 continuous definition 必须使用 `create/addHeartLiveModifierForSourceMember`、`...ForTargetMember` 或 `...ForPlayer` 具名入口。
- 持久化 HEART 的生命周期按显式 scope 处理：ACTIVE / WAITING 朝向变化和成员槽位移动不清除；离开顶层舞台、被替换或成为 `memberBelow` 时，`SOURCE_MEMBER` 随来源成员实例清除，`TARGET_MEMBER` 只随受益成员实例清除，持久化 `PLAYER` 不因来源成员离场而清除；同一实例重登场不得恢复旧 modifier。Continuous HEART 不持久化，每次按当前场面重新收集，其来源或条件失效时会动态消失。RULES、FREE 手动移动和卡效移动必须共享 LeaveStage 清理边界，LIVE 结束再统一清空已持久化 modifier。本类测试不得只断言 modifier 形状，还要断言最终成员 HEART、玩家 HEART、颜色汇总和实际 LIVE 判定，并覆盖离场／重登场。
- `HeartColor.GRAY` 表示实际提供的无色/灰色 Heart，只计入 LIVE 判定总 Heart 数，不能补指定颜色；`HeartColor.RAINBOW` 仍表示可代替任意颜色的 All Heart。判心数据不得再用 `RAINBOW` 代表无色结果；必要无色 Heart 的旧有结构化投影仍可使用 `RAINBOW`/泛用总数语义，规则层同时规范化 `GRAY` 需求输入。
- `HeartColor.ORANGE` 是独立指定色，Loveca Excel / CloudBase token `orange` 必须原样映射。新增该数据能力不代表旧卡文本中的“六种颜色”自动扩展；没有明确新规则或新卡文本依据时，不要把 `ORANGE` 加入历史卡效的固定六色选项。
- “必要HEART增加/减少”类效果应使用 `applyHeartRequirementModifiers`；它支持粉/黄/紫等指定颜色，也支持泛用/无色/All 需求，并兼容 `RAINBOW` 条目和 `totalRequired` 表达的两种数据形态。`PL!-sd1-022-SD` 这种减少 `[無ハート]` 的效果只是其中的 All 需求负修正。
- 前端判定面板读取必要 Heart 修正时要注意投影键：`playerViewState.match.liveResult.requirementModifiers` / `requirementReductions` 当前以 `obj_<cardId>` 为 key，而桌面组件通常使用 raw `cardId`。读取时必须兼容 raw/public 两种 key，否则 `022` 这类效果会在 UI 预览里显示未修正的需求。
- “1回合 N 次”属于能力定义的通用限制，应在 `CARD_ABILITY_DEFINITIONS.perTurnLimit` 登记，由通用 `ABILITY_USE` 记录与校验按 `playerId + abilityId + sourceCardId + sourceLifecycleId + turnCount` 计算。`sourceCardId` 是跨区域保持不变的实体卡 ID；`sourceLifecycleId` 表示该实体卡当前这一次成为能力来源的规则对象：`STAGE_MEMBER / PLAYED_MEMBER` 取最近一次跨区域 `ON_ENTER_STAGE.eventId`，`LIVE_CARD` 取最近一次跨区域 `ON_ENTER_LIVE_ZONE.eventId`，无入口事件的测试直置对象使用确定性 initial sentinel。成员区内移动、LIVE 区内移动及 ACTIVE/WAITING 变化不重置；离场后再次进入来源区域会生成新 lifecycle，因此不受旧对象的已结算、pending 或 active 次数占用。不要删除旧 `ABILITY_USE` 历史，也不要在单张卡效果里临时清次数。

## 费用体系约定

- 活跃阶段进入时由 `GameService` 的 `UNTAP_ALL` 自动动作恢复当前玩家的成员和能量，并遵守成员/能量的活跃阶段跳过标记及常时限制；不得在前端或单卡 workflow 中补一次无条件全部活跃，绕过这些限制。
- 普通登场/换手成员不弹确认窗口，自动支付费用。
- 普通登场自动支付横置前 N 张可用活跃能量，并记录 `PAY_COST` action；当前普通登场命令没有接入卡效内部的特殊能量选择窗口。
- `CONFIRM_COST_PAYMENT` / `pendingCostPayment` 底层仍保留，但普通登场会立即完成计算出的支付，不创建交互窗口。卡效内部的特殊能量选择由 energy-selection runtime 承接，不能据此宣称普通登场也已支持选择支付对象。
- 换手减免通过 `costCalculator` 计算。
- 动态登场费用修正通过 `costCalculator` 计算，不在 UI 或具体命令里临时判断。当前 `LL-bp2-001-R+` 费用 20「渡边 曜&鬼冢夏美&大泽瑠璃乃」已验证手牌中自身按“此卡以外的其他手牌数量”每张 -1 费；这张卡本身不计入数量。`PL!N-pb1-008-P+` 费用 17「艾玛·维尔德」已验证手牌中自身在舞台存在待机状态『虹咲』成员时 -2 费。

## 撤销约定

- 当前撤销是本地/调试桌面的“广义撤销一步”。
- 撤销通过 `GameSession` 保存权威状态快照实现，最多保留 50 步。
- 撤销覆盖玩家在同一操作时点内的桌面动作，例如登场、自动扣费、拖拽、横置、效果确认等。
- 一旦阶段、子阶段、活跃玩家或等待玩家变化，撤销历史会清空。
- 回合开始自动处理、先后攻操作时点交换、盖牌玩家切换后，不允许新操作者撤销上一时点。
- 正式联机支持请求式撤销：发起方请求后由对手拒绝、接受一步或授予同一操作窗口内的连续撤销；服务端负责校验并回滚权威状态。观战与历史回放仍不支持撤销。

## 检视区与效果显示约定

- 翻牌类效果统一优先进入 `inspectionZone`，再执行下一步。
- 公开翻 X 张：双方都看正面，`revealedCardIds` 包含公开牌。
- 自己检视 X 张：控制者看正面，对手看背面。
- 选择后公开其中一张：先控制者看全部，选择后只公开被选牌，再移动到手牌或其他区域。
- 隐藏卡牌刚按卡文变为双方公开、且随后会自动结算或进入下一真实交互时，必须使用 shared Public Reveal Dwell；界面不显示普通确认按钮，到期后由任一参与者安全推进。
- Public Reveal Dwell 只展示本次明确公开的 cardIds，不代替休息室/声援公开区等既有公开来源的 public-card-selection confirmation，也不包装 public-effect-choice 或 queued pending manual confirm-only。
- 正在处理的效果应在桌面中央显示，标题使用“费用 + 卡名”，正文尽量显示卡牌原效果文本，不要加奇怪解释文案。
- 正在处理的效果如果需要玩家选择卡牌，应优先显示卡图网格，并支持 hover 查看卡牌详情；不要只用文字按钮让玩家猜卡。
- 精确选择 1 张的 `ORDERED_MULTI` 步骤默认仍保留选择后的确认按钮；只有效果步骤显式声明 `autoSubmitSingleSelection` 时才允许点击卡牌后立即提交，不得仅根据运行时 `min=1/max=1` 推断，以免误伤弃牌费用、隐藏手牌公开或动态退化成单选的流程。
- 舞台上可发动的起动效果按钮应显示完整效果文本；可以缩小字号和加宽文本框，但不要用省略号截断规则文本。

## 当前样例卡效

具体卡牌的费用/分数、完整或部分实现状态、罕度覆盖和测试入口统一查询 [`existing_module_map.md`](docs/card-effect-reuse-audit/existing_module_map.md)。本指南不重复维护单卡完成清单，避免旧样例被当作当前缺口。

新增卡效的复用入口见 [`new_card_effect_cookbook.md`](docs/card-effect-framework/new_card_effect_cookbook.md)，runner 迁移状态见 [`migration_roadmap.md`](docs/card-effect-framework/migration_roadmap.md)。

## 桌面 UI 约定

- LIVE 区是 3 个横置槽位。
- 成功 Live 区也是横置卡位。
- 能量区活跃/等待需要视觉区分；等待能量横置。
- 成员卡横置/等待使用 `orientation` 传给通用 `Card`。
- 桌面端撤销按钮位于右下角阶段工具条，不放在成功 Live 卡区或左上角；不可撤销时仍保留入口并展示规则层禁用原因。
- 对局桌面可显示“已自动化卡效”的轻量卡面标记：只在前端对局组件中给正面卡牌加卡顶中间约 4px 小点和 1px 圆角外描边，当前可处理/可发动时点和描边变亮；不写入卡牌数据库、不影响后端规则。当前实现入口为 `client/src/lib/cardEffectAutomationVisuals.ts`，通用卡牌组件只接收可选 `effectVisualState` prop。默认开启；构建时可设置 `VITE_CARD_EFFECT_VISUAL_MARKERS=false` / `0` / `off` 关闭。若后续所有卡效都已完成并决定剥离，删除该 helper、`CardEffectMarker`、`Card.effectVisualState` prop 以及 `PlayerArea` 中的传参即可，不应影响权威规则状态。
- 自己的主要阶段中，己方舞台成员若仍有可用的“1回合 N 次”起动效果次数，使用独立紫色高亮描边并覆盖自动化卡效蓝色描边；卡顶自动化小点保留。卡效处理窗口中暂停该提示，优先展示现有的效果来源、合法目标和选择状态；窗口结束后如仍有剩余次数则恢复。
- 新增卡效接入自动化标记时，优先通过能力定义的 `implemented: true` 自动进入标记系统；只有没有 queued/activated ability definition 的 cost-calculator-only 效果，才需要补到 `client/src/lib/cardEffectAutomationVisuals.ts` 的 supplemental set。

## 推荐验证命令

只在用户要求验证、或你做了容易破坏编译/核心规则的改动时运行。

```bash
pnpm test:run tests/unit/energy.test.ts tests/unit/card-effect-classification.test.ts tests/integration/sample-card-effect-runner.test.ts tests/unit/heart-live.test.ts tests/unit/live-judgment-settlement.test.ts
pnpm exec tsc --noEmit
pnpm --dir client exec tsc -b
```

全量验证更重，只有需要时再跑：

```bash
pnpm test:run
pnpm --dir client build
```

## 下一步优先级

项目下一步统一维护在 [`PROJECT_PROGRESS_TODO.md`](PROJECT_PROGRESS_TODO.md)；卡效抽象与迁移的剩余范围查 [`module_gap_list.md`](docs/card-effect-reuse-audit/module_gap_list.md) 和 [`migration_roadmap.md`](docs/card-effect-framework/migration_roadmap.md)。不要沿用旧卡组批次或旧 runner inline 清单安排新开发。
