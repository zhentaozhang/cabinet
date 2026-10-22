# Cabinet 下一阶段计划：Trust Hardening + Memory Depth

> 目标：在保持现有 83 个测试与 3 分钟 demo 可用的前提下，完成 Track A（可发公开链接）与 Track B（记忆/学习深度）。
> 执行顺序：**A 先、B 后**。A2 会改所有 service 签名，B 先做会返工。

## 0. 六条不变量

| # | 不变量 | 验收 |
|---|---|---|
| I1 | 所有查询按 `userId` 作用域 | `rg "DEMO_USER_ID" src/lib/services` = 0 |
| I2 | mutation 幂等可重放 | 同 key 返回同一响应 |
| I3 | LLM 调用不在数据库事务内 | 失败注入测试 |
| I4 | 数据库能挡住自验收 | `CHECK (assignee_id <> auditor_id)` |
| I5 | 记忆检索可解释、冲突由时间轴表达 | Run Trace 显示 score breakdown |
| I6 | 反思不再硬编码，证据可追溯 | 无证据不生成 insight |
| I7 | 技能可灰度/回滚，Agent Card 不泄露私有字段 | 集成测试 |

## 1. 依赖关系

```
P0 安全基线 + 拆分 engine
  → A1 鉴权 + auth schema
  → A2 租户作用域
  → A3 幂等 + Zod
  → A4 短事务 + DB 约束
  → A5 /setup + 安全边界
  → B1 检索融合
  → B2 双时间轴 + 真实反思
  → B3 技能 label + Agent Card
  → C E2E + CI migrate + 文档 + 部署
```

## 2. Phase 0：安全基线 + 拆分 engine（0.5–1 天）

- 分支 `feat/trust-and-memory`；tag `pre-trust-memory`；`pg_dump` 备份。
- 确认 83 tests / typecheck / lint / build 全绿。
- 将 `src/lib/engine.ts` 按领域拆到 `src/lib/services/`：
  - `tasks.ts`：runTask / auditTask / promoteSuggestion
  - `agents.ts`：setAutonomy / updateAgent
  - `insights.ts`：applyInsight / runReflection
  - `councils.ts`：createCouncil / decideCouncil
  - `apprenticeship.ts`：runApprenticeExam
  - `checkins.ts`：saveCheckin
  - `queries/`：today / cabinet / agent / task / review / memory / council / metrics
- `engine.ts` 保留 re-export，全部 import 切换后再删除。
- `logAudit` 有 23 个依赖，最后动；`getTodayData` 有 6 个依赖，单独拆。
- Gate：无行为变化，83 tests 全绿。

## 3. Track A：Trust Hardening（5 天）

### A1 鉴权（1.5 天）

- better-auth + Drizzle adapter；用 `@better-auth/cli generate` 生成与当前版本匹配的 schema，不手写 auth 表。
- 处理现有 `users` 表：优先映射到 better-auth `user` 表，补 `timezone`。
- 新增 `src/lib/auth.ts`、`src/app/api/auth/[...all]/route.ts`、`src/app/login/page.tsx`、`src/middleware.ts`。
- Demo 登录：`DEMO_LOGIN_ENABLED` 控制，生产强制关闭。
- 页面除 `/login`、`/api/auth/*`、`/api/health` 外都需要 session；API 用 `withAuth` 统一 401。
- 测试：未登录 redirect/401；demo login 200；生产 demo login 不可用。

### A2 租户作用域（1.5 天）

- 引入 `RequestContext { userId, timezone }`；所有 service 第一个参数改为 `ctx`。
- 所有查询加 `eq(table.userId, ctx.userId)`。
- 所有权检查：跨用户一律 **404**，不返回 403，避免泄露资源存在性。
- 删除 `DEMO_USER_ID` 默认参数；只保留在 seed / demo login。
- 测试：A 不能读/跑/审/改 B 的 task、agent、insight、approval、council；不能把 task 指派给 B 的 agent；列表只返回自己的数据。
- Gate：`rg "DEMO_USER_ID" src/lib/services src/app` 只剩 seed/login。

### A3 幂等 + Zod（1 天）

`idempotency_keys` 增加 `status`（processing/completed/failed）、`expiresAt`、`responseStatus`。

`withIdempotency`：

1. hash = sha256(userId + method + path + canonicalJson(body))
2. INSERT `(userId,key,endpoint,requestHash,status=processing)`；唯一冲突时：
   - hash 不同 → 409
   - completed → 返回缓存响应
   - processing → 409 in-progress
3. 执行 handler
4. UPDATE responseJson + statusCode + completed
5. 失败 → failed + rethrow

- 所有 mutation 路由接入；UI 生成 `crypto.randomUUID()` 放 `Idempotency-Key`。
- Zod schema 覆盖 agent/goal/task/council/checkin/insight/autonomy；替换路由里的 `as {...}`。
- 测试：同 key 同 body 重放、同 key 不同 body 409、并发 409、非法 body 400。

### A4 短事务 + Saga + DB 约束（1 天）

- `runTask` 拆三段：
  - T1：policy + task→running + insert run（短事务）
  - 执行：LLM/tool/artifact（事务外）
  - T2：artifact + steps + task→submitted + run succeeded + cost + audit（短事务）
  - 失败：T3 run→failed、task→failed、audit
- `auditTask` 同理，只把状态迁移和审计放进事务。
- 不把 LLM 调用放进 `db.transaction`；当前 pool `max:1`，长事务会阻塞。
- 失败注入测试：`generateArtifact` 抛错 → 没有“submitted 但无 artifact”的半成品。
- 迁移新增：
  - `CHECK (assignee_id <> auditor_id)`
  - `CHECK (autonomy_level BETWEEN 0 AND 3)`
  - `CHECK (budget_cents >= 0)`、`CHECK (estimated_cost_cents >= 0)`
  - 核心 FK；用户数据 `ON DELETE CASCADE`
  - `audit_events.seq` 唯一索引
- 迁移前跑 orphan 检查；CI 用 `drizzle-kit migrate`。

### A5 /setup + 安全边界（1 天）

- `POST /api/setup`：创建 user/profile、确保 policy_config、从 `agent_templates` 创建 7 个 Agent、可选示例目标；已有 workspace → 409。
- `/setup` 三步向导：时区/约束 → 目标 → 确认内阁。
- `/api/demo/reset` 仅 dev/admin。
- CSRF：SameSite=Lax + Origin/Sec-Fetch-Site 检查；better-auth 自带沿用。
- Rate limit：`rate_limits` 表（userId + action + windowStart + count），限制 run/reset/login。
- 启动时用 Zod 校验 env。
- `GET /api/export`、`DELETE /api/account`（级联删除）。
- 测试：未登录 setup 401、重复 setup 409、生产 reset 不可用、跨站 mutation 403、429。

## 4. Track B：Memory & Learning（3.5 天）

### B1 检索三信号融合（1 天）

`src/lib/memory/retrieval.ts`：

- 候选：当前用户、active、validTo null、最近 200 条。
- `recency = 0.99 ^ hours`；`relevance` 用 `Intl.Segmenter` 中英文词重叠；`importance = salience`。
- 归一化后：`0.5*recency + 3*relevance + 2*importance`。
- 返回 top 8 + `scoreBreakdown`；`runTask` 的 context step 记录 retrieved。
- 不引入向量库；效果不够再上 pgvector。
- 测试：近期低相关 vs 较早高相关；高 salience 无查询词；跨用户不进入候选。

### B2 双时间轴 + 真实反思（1.5 天）

- `memories` 增加 `factKey`、`value`、`validFrom`、`validTo`、`supersededBy`。
- 同 factKey 冲突：旧事实 `validTo=now`、`supersededBy=new.id`、`status=superseded`；新事实 `validFrom=now`；历史保留。
- 无法判断 → 两条保留、标记 conflicted，等用户确认。
- 检索只取 `validTo IS NULL`；Memory 页增加“当前 / 历史”。
- `runReflection` 改为从 checkins/runs/audit/memory changes 生成：
  - 规则层：跳过模式、时段、任务时长、驳回原因
  - LLM 层（可选）：claim/rationale/evidence/confidence/proposedChange
  - 校验 evidence.ref 必须真实存在且属于当前用户
  - 触发阈值放 `policy_config`；无 LLM 时规则 fallback
- 测试：3 次跳过晚间任务 → 时段洞察；伪造 evidence 被拒；无事件不生成；采纳/回滚正确。

### B3 技能 label + Agent Card（1 天）

- `skills.label`：draft/canary/production/retired；新增 `skill_versions`。
- 考试从 `skills.evalSet` 读取，阈值来自 `policy_config`；晋级/回滚 = 改 label。
- Agent Card：`GET /api/agents/[id]/card`，A2A 形状；allowlist 字段，不暴露 email/health/memory；第一版不签名。
- 测试：Card schema；私有 Agent 跨用户 404；技能晋级/回滚。

## 5. Phase C：集成与交付（1 天）

- E2E：登录 → setup → 目标/任务 → 执行 → 验收 → 复盘；双用户隔离；幂等重放。
- CI：`migrate` 而非 push；Postgres service；typecheck/lint/test/build。
- 文档：README + 本计划进度。
- 部署：`AUTH_REQUIRED=true`、`DEMO_LOGIN_ENABLED=false`。

## 6. 工时

| 阶段 | 工时 |
|---|---|
| P0 | 0.5–1d |
| A1 | 1.5d |
| A2 | 1.5d |
| A3 | 1d |
| A4 | 1d |
| A5 | 1d |
| B1 | 1d |
| B2 | 1.5d |
| B3 | 1d |
| C | 1d |
| 合计 | 10.5–11d |

6 天压缩版：A1+A2 → A3+A4 → B1 → B2 规则版 → B3 最小 Card；延后 /setup、CSRF/rate limit、技能灰度、签名。

## 7. 测试矩阵

- Unit：policy、state、time、retrieval、temporal、reflection rules。
- Integration：auth 401、跨用户 404、幂等、saga 失败补偿、FK/CHECK、检索、反思证据、技能、Agent Card。
- API contract：400/401/403/404/409/202/429。
- E2E：登录 → setup → 目标 → 任务 → 审计 → 复盘 → 回滚；双用户隔离。
- Migration：0000 → latest 在 `cabinet_test` 上通过。

## 8. 验收清单

- [ ] `rg "DEMO_USER_ID" src/lib/services` = 0
- [ ] 未登录 redirect/401；A 访问 B → 404
- [ ] 同 Idempotency-Key 重放 → 同一响应；不同 body → 409
- [ ] LLM 失败 → 无“submitted 但无 artifact”
- [ ] DB 拒绝 `assignee = auditor`
- [ ] 删除用户 → 级联清理
- [ ] Retrieval 有 score breakdown；只取当前事实
- [ ] 反思不硬编码；伪造 evidence 被拒
- [ ] 技能晋级/回滚正确
- [ ] Agent Card 不泄露私有字段
- [ ] `/setup` 可创建 7 个 Agent
- [ ] CI 用 migrate，全绿

## 9. 风险与回滚

| 风险 | 预防 | 回滚 |
|---|---|---|
| Auth schema 冲突 | CLI 生成；副本迁移 | 恢复 dump；`AUTH_REQUIRED=false` |
| 租户漏改 | 必填 ctx + 跨用户测试 + grep | 回退 A2 |
| 幂等竞争 | 唯一索引 + status | 关闭 `IDEMPOTENCY_REQUIRED` |
| Saga 卡死 | 明确状态机 + 补偿 + 注入测试 | 回退 runTask |
| FK 孤儿 | orphan SQL + 回填 | 不执行约束迁移 |
| 检索回归 | golden tests + fallback | `MEMORY_RETRIEVAL=false` |
| 反思幻觉 | schema + evidence 校验 + 规则 fallback | 关闭 LLM 反思 |
| Card 泄露 | DTO allowlist + 测试 | 下线端点 |

## 10. 本轮不做

Merkle 树、Biscuit、OPA/Rego、链上身份、完整 mem0/Graphiti、Guest Agent 结算。

---

## 进度

- ✅ A1：better-auth、登录页、demo 账号、`AUTH_REQUIRED` 开关、`proxy.ts`、`drizzle/0001_auth.sql`。
- ✅ A2：所有 service/query 接收 `userId`；跨用户访问返回 404；新增 7 条租户隔离测试。
  - engine 拆分仍延后，先完成安全/可靠性主线。
- ✅ A3：`withIdempotency` + `Idempotency-Key` + Zod schema；同 key 重放返回缓存响应，不同 body 409，并发 409。
- ⏳ A4–A5、B1–B3、C：未开始。
