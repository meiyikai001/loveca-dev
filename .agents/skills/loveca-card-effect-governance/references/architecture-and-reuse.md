# 架构与复用

适用：新建或晋升 workflow、卡效架构审查、候选筛选和执行提示词。审查范围由用户请求与真实 diff 确定，不以固定命令清单、行数或输出模板替代判断。

## 当前边界

- `src/application/card-effect-runner.ts` 的完整卡效 fallback 已迁出。可保留 handler import/register、pending/activeEffect 生命周期、trigger/activated 调度、`enqueueTriggeredCardEffects` 及尚未迁出的 trigger/relay/matcher 胶水。
- 新增或修改 runner 时查看实际 diff：薄注册、通用 runtime/registry hook 可以保留；单卡 gate、predicate、pending 构造、observer 主体和结算流程应移到 workflow/runtime。resolved-ability observer 通过 registry 注册，runner 只调用通用 hook。
- 不以文件长度决定正确性，不固定统计 runner 增长；注册多不等于业务回流，短的单卡硬编码同样可能越界。涉及 shared 调度时检查事件消费、pending continuation、费用支付和来源身份是否改变。
- 定义集中于 `src/application/card-effects/definitions/index.ts`，在 `CARD_ABILITY_DEFINITIONS` 按多段能力分别登记 abilityId、category、sourceZone、triggerCondition、queued、implemented；区域限定优先使用 `requiredSourceSlots`，触发阶段检查/记录 `PendingAbilityState.sourceSlot`，不散落槽位 gate。不为单纯整理拆 definitions。
- query/selector 只读状态，domain 不依赖 application；runtime 包含动作与生命周期原语；workflow 表达卡文顺序。不把单卡逻辑塞到 React、action handler 或通用查询层。

## 复用决策

先按基础编号查主登记册与现有 definition/workflow/test，避免重复注册。需要判断复用时检索 shared family 和邻近单卡实现，不通读所有文件。

- 已有稳定 family 时扩配置；只重复原子动作时抽取或复用 helper/query/event wrapper。
- 成为 family 的依据是费用时机、目标结构、事件入队、skip/continuation 和 modifier target 语义一致，差异能由少量稳定参数表达。文案相似或同一开发批次本身不构成 family。
- 第二个真实样本出现时重新评估晋升；说明实际配置轴和保留的差异。轴不稳定或流程特殊时保留薄单卡编排，复用底层动作，不强行泛化。
- steps-lite 仅作为稳定重复 family 的 typed builder，不做通用解释器/DSL，也不要求复杂单卡 steps 化。只有具体任务涉及该层时读取框架内的 `steps_lite_plan.md` 与 `steps_promotion_queue.md`。
- 纯 trigger matcher 只匹配事件事实与 ability/source，不处理目标、费用、次数消耗、pending 顺序或结算。T-2 未明确开启前不接入 runner、不替换生产 enqueue；shadow 范围按当前任务检查，不能宣称已接线。详见框架内 `trigger_matcher_plan.md`。

## 文件归属

以下目录相对 `src/application/card-effects/workflows/`：

- `cards/` 文件承载一个基础编号及其全罕度，命名为基础编号 kebab + 卡名英文/罗马字 slug；保留系列身份，例如 `pl-bp6-020-dancing-stars-on-me.ts`、`n-bp3-030-love-u-my-friends.ts`、`sp-pr-018-kanon.ts`。不要按批次或临时效果描述命名单卡文件。
- 多基础编号稳定 family 放 `shared/`，以可复用行为命名；不能因同批开发把无关卡放在一个单卡文件中。同基础编号多罕度不拆文件。
- 单卡扩出第二个基础编号时：稳定 family 迁 shared；无关流程拆单卡；仅局部动作相同抽 helper。已有跨卡行为名文件也应归 shared。
- 测试名跟随 ownership：单卡说明基础编号与卡名，shared 说明行为。旧组合测试明确覆盖范围，不为此次无关历史命名发起全库重构。
- 重命名时同步 import/注册、definition note、主登记册与测试引用，并搜索旧路径残留。

## 候选与审查结果

- 候选卡先查已有实现，再核对指定 JSON 与当前缺口。区分整卡完成、部分效果段和罕度覆盖；已覆盖的部分不建议重复开发。
- 多卡按真实效果形状与可复用底座分组，优先共享 workflow、触发/选择形状和测试夹具。只有比较有帮助时使用表格；无需为单卡输出固定十一项。
- 结果应让用户能判断：卡牌与效果范围、已实现情况、建议实现位置/复用项、真实风险、验证与登记要求。引用必要卡文段落，不默认复制全部日中正文。
- 只有请求执行提示词时才生成，写清目标、数据文件、范围、必要约束和完成条件，不把本 skill 全文再复制到提示词。仅候选建议不擅自实现；已明确要求实现的批次不重复等待筛选批准。
- 实际卡文与任务描述矛盾且影响规则解释时，先报告并澄清该卡，其他独立工作可继续。审查按严重程度报告有证据的问题；没有阻塞时明确说明，不以假设风险扩张任务。

## 文档与验证入口

需要设计依据时读 [模块边界](../../../../docs/card-effect-framework/module_boundaries.md) 的相关章节；family 组织看 [workflow 指南](../../../../docs/card-effect-framework/workflow_module_guide.md)，阶段接线看 [迁移路线](../../../../docs/card-effect-framework/migration_roadmap.md) 的相关记录。源码/diff 说明实现状态，历史路线和 README 不单独证明“已完成”。

新增/完成效果更新主登记册；抽出 helper/family 或改变事件边界时更新相应 cookbook、runtime/workflow、roadmap 或覆盖/gap 章节，不机械刷新每份文档。保持表述诚实：shadow 不是生产接线，局部 helper 不是全局覆盖，单卡 workflow 不是 shared family。

分类登记回归入口为 `tests/unit/card-effect-classification.test.ts`，workflow 使用对应 focused integration；新增 query/helper 测正反例，事件 wrapper 验证事件与入队以及零移动不误触发。共享路径改动覆盖受影响旧卡，普通配置追加不重跑所有框架测试。
