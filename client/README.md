# Loveca Web 客户端

> 文档类型：总览文档
> 适用范围：`client/` 客户端目录、常用命令、主要模块和后端依赖
> 当前状态：现行客户端入口

React + Vite + TypeScript 客户端，负责牌桌、卡组管理、卡牌管理后台、账号流程和正式联机房间界面。

## 常用命令

```bash
pnpm --dir client dev
pnpm --dir client build
pnpm --dir client lint
pnpm --dir client test:e2e:mobile
pnpm --dir client test:e2e:visual
pnpm --dir client preview
```

视觉基线仅在明确接受页面变化时通过 `pnpm --dir client test:e2e:visual:update` 更新；不同运行平台使用各自的截图目录。

## 主要目录

- `src/components/game`：牌桌、玩家区域、阶段面板、判定与结算 UI
- `src/components/pages`：首页、对局入口、正式联机、调试联机、分享卡组页面
- `src/components/deck`、`src/components/deck-editor`：卡组列表、导入导出、构筑编辑器
- `src/components/admin`：运营管理中心，以及卡牌、同步、AI 配置、用户、赛季、分类、平台数据、快捷表情与候场曲库等管理页面
- `src/store`：Zustand 状态管理
- `src/lib`：REST API、图片、卡牌、联机、管理员 AI 提取客户端与应用更新协调器

## 后端依赖

生产与完整开发流程依赖根项目的 Express API。客户端默认同源访问 API；本地调试可通过 `VITE_API_BASE_URL` 指向后端服务。
