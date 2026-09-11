# Card Effect Framework

> 文档类型：总览文档
> 适用范围：卡效框架目标态、阅读入口、权威文档关系与迁移边界
> 当前状态：现行卡效框架总入口；新增长期卡效框架文档时应同步更新

本文是卡效框架的主入口。需要框架设计依据时，从这里定位相关文档与章节。

## Current Goal

`card-effect-runner.ts` 的完整卡效 fallback 已清空，当前阶段目标是维护已经落地的去中心化边界，并只在明确开启对应架构窗口时继续收口调度胶水：

- runner 保留 pending / activeEffect 生命周期、trigger/activated 调度入口、workflow registry 注册，以及尚未迁出的 matcher / relay / trigger 条件胶水。
- 原子动作放入 `src/application/card-effects/runtime/`。
- 具体卡牌流程放入 `src/application/card-effects/workflows/cards/`，同型 family 放入 `workflows/shared/`。
- 能归类的效果按 workflow family 参数化；不能归类的特殊卡也单独放 workflow 文件，不再留在 runner。
- trigger matcher 继续保持纯 matcher，等 runner 调度边界稳定后再接入。
- steps-lite 只在真实重复 workflow 已稳定后推进，不做完整解释器。

## 按任务导航

这些链接是主题索引，不是必读清单；只检索当前问题所需的章节、基础编号与源码。开发/审查流程以 [卡效 skill](../../.agents/skills/loveca-card-effect-governance/SKILL.md) 为入口，不要求读完本目录后才能改代码。

| 当前问题 | 对应资料 |
| --- | --- |
| 某张卡是否已实现、缺哪段 | 在 [主登记册](../card-effect-reuse-audit/existing_module_map.md) 按基础编号查条目，再核对 definition/workflow/test；不全文加载 |
| 已知效果如何接入或复用 | [实现指南](card_effect_implementation_guide.md) 与 [cookbook](new_card_effect_cookbook.md) 中对应效果形状 |
| runner、query、runtime、workflow 归属 | [模块边界](module_boundaries.md)；确需整体架构设计时读 [目标架构](target_architecture.md) |
| 抽弃/移动/状态 helper、activeEffect 恢复或 shared family | 分别定位 [动作 helper](runtime_action_helpers.md)、[activeEffect](active_effect_runtime.md)、[workflow](workflow_module_guide.md) 的相关章节 |
| trigger matcher 接线或 steps-lite 晋升 | 任务明确涉及后再看 [matcher 计划](trigger_matcher_plan.md)、[steps-lite](steps_lite_plan.md) 或 [晋升队列](steps_promotion_queue.md) |
| 迁移是否已完成、当前缺口 | 对照源码/diff 与 [迁移路线](migration_roadmap.md) 对应记录；按需查 [模块覆盖](../card-effect-reuse-audit/effect_module_coverage.md) / [缺口](../card-effect-reuse-audit/module_gap_list.md) |
| 旧文档的权威关系 | [旧文档索引](legacy_doc_index.md) |

规则与玩家正文使用任务指定的导出 JSON；文档历史描述不替代卡文，也不单独证明代码已接线。详细卡效不变量与适用回归通过 skill 的主题参考读取，避免在本导航重复维护。

## Authoritative Documents

| 文档 | 责任 |
|---|---|
| [target_architecture.md](target_architecture.md) | 卡效系统最终目标态、目录结构和调度模型。 |
| [module_boundaries.md](module_boundaries.md) | query、runtime action、workflow、runner、domain modifier 等模块边界。 |
| [new_card_effect_cookbook.md](new_card_effect_cookbook.md) | 新增/扩展卡效时按常见效果选择 workflow/helper 的一页式入口。 |
| [runtime_action_helpers.md](runtime_action_helpers.md) | 抽牌、弃牌、回收、看顶、区域移动等原子动作 helper 的参数轴和迁移状态。 |
| [workflow_module_guide.md](workflow_module_guide.md) | workflow family 与特殊卡 workflow 应如何组织、导出和测试。 |
| [active_effect_runtime.md](active_effect_runtime.md) | activeEffect / stepId / metadata / 可见性 / step handler registry 的运行时约定。 |
| [migration_roadmap.md](migration_roadmap.md) | runner 去中心化迁移顺序、完成标准和禁止事项。 |
| [trigger_matcher_plan.md](trigger_matcher_plan.md) | 纯 trigger matcher 的字段边界、shadow test 与 T-2 接线计划。 |
| [steps_lite_plan.md](steps_lite_plan.md) | steps-lite 的目标、非目标和与 workflow helper 的关系。 |

## Registries

| 文档 | 责任 |
|---|---|
| [existing_module_map.md](../card-effect-reuse-audit/existing_module_map.md) | 卡牌基础编号完成状态，新增/补全卡效时必须优先同步。 |
| [effect_module_coverage.md](../card-effect-reuse-audit/effect_module_coverage.md) | 已有通用模块覆盖哪些效果碎片。 |
| [module_gap_list.md](../card-effect-reuse-audit/module_gap_list.md) | 剩余缺口、下一批抽象候选和风险。 |
| [condition_query_remaining_inventory.md](../card-effect-reuse-audit/condition_query_remaining_inventory.md) | condition/query 与 selector 清单。 |

## Hard Boundaries

- 不新增完整 steps 解释器 / DSL。
- 不把 trigger matcher 接入 runner，除非明确开启 T-2。
- 普通同构追加保持既有 pending 顺序、事件消费与费用语义；任务明确要求修复或扩展这些规则时，只改必要边界并覆盖相关回归，不把局部卡效开发扩大为无关框架接线。
- 不为了整理文档拆 `src/application/card-effects/definitions/index.ts`。
- 不把 `llocg_db`、`assets/card/`、`assets/images/`、`trigger` 纳入普通卡效或框架提交。
- 新增复杂卡效时，不能继续把完整 workflow 直接写进 runner；至少应放入 workflow module 或复用既有 workflow helper。
