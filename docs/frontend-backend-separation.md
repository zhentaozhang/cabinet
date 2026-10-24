# 前后端分层与拆分手册

> 目标：让「前端」和「后端」在**代码层面已经不共享任何进程内依赖**，只通过 HTTP + 契约通信。
> 这样把它们拆成两个部署单元时，不需要重写业务，只需要搬运目录和改一个环境变量。

---

## 1. 现在是什么结构

```
src/
├── contracts/          ← 契约层：zod schema + DTO 类型 + 文案标签 + 路由常量
│   ├── dto/            entities · aggregates · common
│   ├── errors.ts       错误码 → 语义（前后端共用）
│   ├── labels.ts       状态 → 中文文案/tone（唯一来源）
│   ├── routes.ts       API 路径常量
│   └── templates.ts    纯函数模板（不碰 DB / 不碰 React）
│
├── server/             ← 后端：只有它能碰数据库
│   ├── services/       engine（领域逻辑、事务、审计链）
│   ├── readmodels/     today · review · cabinet · memory · council · agent · task · shell
│   ├── mappers.ts      DB row → DTO
│   └── dto-guard.ts    asDto()：运行时校验出参
│
├── app/api/**          ← 后端入口：44 个 route handler（唯一的服务器 API 面）
├── lib/api/**          ← 客户端 SDK + 服务端调用器 + 写操作管线（CSRF / 限流 / 幂等）
│
├── app/**/page.tsx     ← 前端页面（RSC）：只调 fetchXxx()，不 import server/
└── components/         ← 前端组件：只认 DTO 类型
```

**一句话：`app/**`（除 `api/` 外）和 `components/**` 只允许 `@/contracts` 和 `@/lib/api`。**

这条规则不是口头约定，是 **lint 规则 + 单元测试** 双重强制的：

| 守卫 | 位置 | 作用 |
|---|---|---|
| ESLint `no-restricted-imports` | `eslint.config.mjs` | 页面/组件 import `@/server/*`、`@/lib/db`、`@/lib/engine`、`drizzle-orm` 直接报错 |
| 架构测试 | `tests/unit/boundary.test.ts` | CI 里再断言一遍；另加「contracts 只能依赖 zod」「server 不许反向 import UI」「每个 route 都有 handler」 |

改架构时先跑 `pnpm lint && pnpm test`，规则会告诉你有没有越界。

---

## 2. 一次请求是怎么走的

### 读（页面渲染）

```
page.tsx (RSC)
  → lib/api/pages.ts fetchTodayPage()
    → lib/api/server.ts 组装 baseUrl + 转发 cookie
      → GET /api/today
        → lib/api/read.ts handleQuery()      ← getApiUserId()
          → server/readmodels/today.ts loadToday(userId)
            → server/services/engine        ← SQL
          → mappers + asDto()               ← 运行时校验
        ← { ok: true, data }
    ← zod 解析（失败即抛，不静默）
  ← 渲染
```

页面拿到的是**已校验的 DTO**，不是 DB row。字段改名、日期格式、枚举收窄都发生在 `mappers.ts` 一处。

### 写（按钮点击）

```
客户端组件
  → lib/api/browser.ts browserApi.mutation()
    → lib/api/client.ts apiFetch()          ← 永不 throw，返回 {ok:true}|{ok:false,error,code}
      → POST /api/tasks/x/run
        → lib/api/mutation.ts handleMutation()  ← CSRF 同源校验 → 鉴权 → 限流 → 幂等 → 业务
      ← { ok, data } | { ok:false, error, code }
  → 失败显示 code 对应的中文；成功 router.refresh()
```

`apiFetch` 的三条硬约定：

1. **永不抛异常**，网络错误/非 JSON/5xx 都折叠成 `{ok:false}`，UI 不会卡在 loading。
2. **自动带 `Idempotency-Key`**（仅写操作），双击不会产生两条记录。
3. **响应必须能过 zod**，契约漂移在第一次点击就暴露。

---

## 3. 要拆成两个部署单元时，只剩三步

因为进程内耦合已经清零，物理拆分是机械操作：

### 步骤 1：把后端搬到独立应用

```
apps/api/          ← 新 Next.js 应用（或 Fastify/Hono，见下）
  src/app/api/**   （原样复制）
  src/server/**
  src/lib/api/{mutation,read,rate-limit,idempotency}.ts
  src/lib/db/**  src/lib/auth/**  src/lib/domain/**  src/lib/llm.ts
```

### 步骤 2：前端只保留 UI

```
apps/web/
  src/app/**（除 api/）
  src/components/**
  src/lib/api/{client,browser,pages,server}.ts
```

### 步骤 3：指向新地址

```bash
# apps/web/.env.local
API_BASE_URL=https://api.example.com
```

`src/lib/api/server.ts` 已经优先读 `API_BASE_URL`，没配置时回落到当前请求的 host —— 所以**本地开发不需要配这个变量**，拆不拆都能跑。

### 跨域时要额外处理（现在同源，所以未做）

| 事项 | 现状 | 拆分后需要 |
|---|---|---|
| CORS | 无需 | `Access-Control-Allow-Origin` + `Allow-Credentials` |
| Cookie | 转发 `cookie` header | `SameSite=None; Secure`，cookie domain 指向 API |
| CSRF | 同源断言 | 改为 Origin 白名单校验 |
| 幂等 | header 透传 | 不变 |

这三项集中在一个地方改：`src/lib/api/mutation.ts` 的 `assertSameOrigin()` 与 `browser.ts` 的 `credentials` 选项。

> 如果后端要换语言（Go/Python），`src/contracts` 就是需要重写的全部「业务契约」；
> 页面、组件、`lib/api/client.ts` 一行都不用动。

---

## 4. 施工顺序（已完成的路径，可复现）

| # | 批次 | 内容 | 验证 |
|---|---|---|---|
| 1 | 契约 | `contracts/dto/*` + `mappers` + `asDto` | `tsc --noEmit` |
| 2 | 读接口 | `readmodels/*` + `GET /api/{today,review,cabinet,memory,council,agent,task,shell}` | curl 返回 `{ok:true}` |
| 3 | 前端换线 | 页面从 `getXxxData()` 改为 `fetchXxxPage()` | 页面 200、内容一致 |
| 4 | 单点化 | 状态文案 → `contracts/labels.ts`；模板 → `contracts/templates.ts` | 全仓 grep 无重复 map |
| 5 | 收口 | `lib/api/client.ts` 统一错误/幂等；`apiFetch` 替换手写 fetch | 断网点击不卡死 |
| 6 | 上锁 | ESLint 边界规则 + `boundary.test.ts` | lint/test 全绿 |

**顺序不能反**：先立契约再换线，否则会出现「页面按旧字段传参、接口已改」的中间态。

---

## 5. 验收命令

```bash
pnpm typecheck     # 类型
pnpm lint          # 含分层边界规则
pnpm test          # 单元 + 集成 + 架构边界
pnpm build         # 构建（route 表会打印 API 面）
node node_modules/next/dist/bin/next start -p 3210   # 冒烟
```

> 本仓库的 pnpm 在本机沙箱下会因 `~/Library/pnpm` 不可写而失败，
> 可直接用 `node node_modules/typescript/bin/tsc --noEmit`、
> `node node_modules/eslint/bin/eslint.js .`、`node node_modules/vitest/vitest.mjs run` 等价执行。

---

## 6. 还剩什么没做（诚实清单）

1. **`contracts` 尚未拆成独立 npm 包**。现在靠 `@/*` 别名共享；拆包后后端可用不同语言实现。
2. **RSC 通过 HTTP 自调用**。同源时是 loopback 请求（~几 ms），优于“页面直连 DB”的耦合，但不如直接调 service 快。
   若将来 API 独立部署，这就是正确形态；若永远单体，可加 `React.cache()` 抹平。
3. **没有 OpenAPI 文档**。契约的机器可读版本是 zod schema，人读版本待补。
4. **组件测试仍缺**（无 jsdom / Testing Library）。边界由集成测试与 lint 兜住，交互细节暂无回归网。
5. **分页**：`memory` / `review` 仍是全量读取，数据量上来需要游标分页。

---

## 7. 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面 500 且日志有 `Invalid DTO` | 服务端返回字段与契约不符 | 修 `mappers.ts` 或对应 schema |
| 点击按钮无反应 | 旧代码用了 `res.json()` 直接取 | 改用 `apiFetch`，它会返回 `ok:false` |
| 一直转圈 | `busy` 未在 `finally` 里复位 | 用 `apiFetch` + `try/finally` |
| 数据重复 | 幂等键在重试时变了 | 键绑定「逻辑事件」，不要每次点击新建 |
| lint 报 `no-restricted-imports` | 页面直接 import 了 server 代码 | 走 `lib/api/pages.ts` 加一个 fetch 函数 |

## 一种响应信封

每个接口，读和写，成功时都是同一个形状：

```json
{ "ok": true, "data": { ... } }
```

失败时：

```json
{ "ok": false, "error": "人话原因", "code": "policy_denied" }
```

`code` 是机器判定的枚举（`unauthorized | forbidden | rate_limited |
validation_error | policy_denied | conflict | not_found | internal_error`），
`error` 是给人看的句子。客户端只对 `code` 做分支，永远不要把 `error` 当条件用——
它是文案，会被改。

写入路由的 handler 仍然返回扁平对象（`{ok:true, runId}`），由 `handleMutation`
统一包装。这样「线上只有一种形状」和「handler 不必样板化」同时成立；需要读旧形状的
调用方可以显式传 `envelope: "flat"`，这是唯一的例外出口。
