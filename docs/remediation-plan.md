# Cabinet 机制修复计划

> 目标：把“演示出来的机制”变成“运行时真的执行的机制”。
> 原则：不动 UI 视觉、不换技术栈、不引入新框架；每一步可独立回滚。

## 1. 六条不变量

| # | 不变量 | 修复前 |
|---|---|---|
| I1 | 非 `active` 的 Agent 不能执行任务 | paused 仍可跑 |
| I2 | 执行者不能给自己验收；Auditor 必须独立且 active | 自验收通过 |
| I3 | 每个有副作用的动作都必须过 policy：状态、自主等级、授权、预算、审批 | 只检查存在性 |
| I4 | 每个状态迁移都有条件更新 + 幂等；重复请求不产生第二次副作用 | 双采纳产生 2 条记忆 |
| I5 | 所有机制阈值来自配置表，不写死在代码里 | 70 / 3 / 45 / 0.8 散落 |
| I6 | 所有指标从事件实时计算，不读种子常量 | AAO 5、2.8m、18%、38% 写死 |
| I7 | 多步写入在同一个事务里；审计链可验证 | 无事务、无验证入口 |
| I8 | 所有查询按 `user_id` 作用域，来自请求上下文 | `DEMO_USER_ID` 全局 |

区分两类硬编码：

- **机制硬编码**（阈值、公式、状态迁移、特殊 ID）→ 必须消灭。
- **演示内容**（seed 文案、示例任务）→ 允许，但只能在 seed / templates，不能进入运行时判断。

## 2. 基线（codegraph + 实测）

Cabinet 本地索引：44 文件，375 节点，1MB（`.codegraph/` 已 gitignore）。

| 符号 | 影响 | 判断 |
|---|---|---|
| `logAudit` | 23 个符号 | 最高风险，先加测试 |
| `getTodayData` | 6 个符号 | 指标改造会波及 |
| `runTask` / `auditTask` / `setAutonomy` / `applyInsight` / `decideApproval` / `decideCouncil` / `runApprenticeExam` | 各 1 个 API caller | 低风险，可安全拆分 |

已复现缺陷：

| 缺陷 | 复现 | 根因 |
|---|---|---|
| 自验收 | `tsk_research` assignee=auditor → accepted | `auditTask` 无检查 |
| 暂停 Agent 可执行 | `ag_coach` paused → run succeeded | `runTask` 无检查 |
| 双采纳 | 连续 accept → 2 条记忆 | `applyInsight` 无状态守卫 |
| 回滚未采纳洞察 | proposed → rollback → task=45 | 无 `applied` 前置 + 默认值反推 |
| 双考试 | 连续 exam → trust +20 | 无 lifecycle 守卫 |

## 3. 目标架构

```
UI → API (auth + zod + idempotency) → Services (tx) → Domain (pure) → DB
```

新增：

```
src/lib/domain/{state,policy,metrics,time,errors}.ts
src/lib/services/{tasks,insights,councils,apprenticeship,agents,checkins}.ts
src/lib/api/{handler,idempotency}.ts
src/lib/policy/{config,matrix}.ts
```

`engine.ts` 先保留 re-export，等所有 import 切换后再删除。

## 4. 数据模型（先加后收紧）

### 0001 additive

| 表 | 新增 |
|---|---|
| tasks | action_type, risk_level, requires_approval, approval_threshold_cents, estimated_cost_cents, quality_gate, accepted_at, accepted_autonomy_level |
| agents | budget_period_start, policy_json |
| insights | before_state, after_state |
| audit_events | seq bigserial unique |
| new | policy_config, idempotency_keys, user_actions, agent_templates |

### 0002 constraints（先查孤儿）

- FK：tasks→agents/goals、runs→tasks/agents、steps→runs、artifacts→runs/tasks、memories→users、insights→users、approvals→tasks/runs、audit→users、skills→agents、councils→users、positions→councils、checkins→users。
- `CHECK (assignee_id <> auditor_id)`；`CHECK (autonomy_level BETWEEN 0 AND 4)`。
- partial unique：`approvals(task_id, action) WHERE status='pending'`。

### 0003 backfill

- `accepted_at/accepted_autonomy_level` 从 `audit.accept` 回填。
- `audit_events.seq` 按 created_at,id 回填。
- `action_type` 默认 internal；seed 写正确值。
- `budget_period_start` = 当前周周一 00:00（用户时区）。

## 5. 核心设计

### 5.1 状态机

```
Task: planned→assigned→running→submitted→auditing→accepted|rejected
      rejected→running
      assigned→awaiting_approval→approved→running
      suggested→planned
Agent: probation→active→paused→retired；active↔paused
Insight: proposed→applied|rejected；applied→rolled_back
Approval: pending→approved|rejected|expired
Council: open→decided
Apprentice: shadowing→drafting→examining→active|retired
```

条件更新：`UPDATE ... WHERE id=? AND status=? RETURNING *`；0 行 → 409。

### 5.2 Policy

```ts
decidePolicy({action, actor, task, grants, budget, config, approval})
→ { effect: "allow" | "suggest" | "require_approval" | "deny", reason }
```

| 动作 | L1 | L2 | L3 |
|---|---|---|---|
| internal_read | allow（有 grant） | allow | allow |
| internal_write | suggest | allow | allow |
| external_action | suggest | require_approval | allow（grant + 预算内） |
| spend | deny | require_approval | 阈值内 allow，否则 approval |
| audit | 仅 auditor 且非 assignee | 同左 | 同左 |
| admin | 仅 user | 仅 user | 仅 user |

阈值来自 `policy_config`；缺失时 fail-closed。审批通过后任务 `approved`，run 时消费一次。

### 5.3 预算

- 已花 = `SUM(runs.cost_cents) WHERE agent_id=? AND created_at>=period_start`。
- 预估 = `tasks.estimated_cost_cents`（不再用 0.8 系数）。
- 超限 → require_approval；实际超支 → `budget_breach` 审计 + 审批。

### 5.4 事务 / 幂等 / 审计

- 事务包裹：run/audit/insight/exam/approval/council/checkin。
- `Idempotency-Key` + `idempotency_keys`；同 key 同 hash 返回缓存；不同 hash 409。
- 锁顺序：task → agent → approval → audit。
- 审计：`seq` + advisory lock；`verifyAuditChain(userId)`；事件目录固定。

### 5.5 指标

| 指标 | 公式 |
|---|---|
| AAO/week | accepted_at 在周内且 accepted_autonomy_level≥2 |
| Adherence | 完成计划任务 / 计划任务 |
| Management | `SUM(user_actions.duration_ms)`，无测量时用决策数×配置并标注 estimated |
| Cost | 周内 runs.cost_cents 求和 |
| Goal progress | accepted/done 任务 / 总任务（公式版本化） |
| Audit reject | rejects / (accepts+rejects) |

`reviews.metrics` 只存生成快照，不手填。

### 5.6 管理动作

`POST /api/goals`、`POST /api/tasks`、`POST /api/agents`、`PATCH /api/agents/[id]`、`POST /api/councils`；UI 弹窗；`/setup` 创建 workspace，seed 只用于 demo。

### 5.7 鉴权

better-auth + middleware；service 接收 `ctx.userId`；`DEMO_USER_ID` 只用于 seed/demo login；mutation 校验 session；生产禁用 reset。

## 6. 硬编码替换表

| 位置 | 现状 | 目标 |
|---|---|---|
| setAutonomy 70/3 | 代码 | policy_config |
| 连续 2 次驳回 | README 有、代码无 | policy_config + 实现 |
| rollback 45 | 代码 | insights.before_state |
| AAO/2.8/18/38 | seed/JSX | metrics SQL |
| tsk_quiz 特判 | taskId | quality_gate + 审计证据 |
| ag_apprentice/ag_coach | 固定 ID | role + lifecycle |
| exam 绑定 tsk_quiz | 固定 taskId | 独立 exam 记录 |
| DEMO_USER_ID | 全局 | 请求上下文 |
| 0.8 成本 | 代码 | estimated_cost_cents |
| priorRuns>=2 rubric | 代码 | 质量门 + 上次 reject 证据 |
| draftFor 标题判断 | 字符串 | task.template |
| seed 静态 metrics | 常量 | 生成快照 |

## 7. 阶段与门禁

| 阶段 | 内容 | 门禁 | 回滚 |
|---|---|---|---|
| P0 基线 | 分支、tag、dump、Vitest、CI | 基线测试绿；demo 录屏 | 删分支 |
| P1 Schema | 0001 additive | 测试库迁移通过；旧页面 200 | down/恢复 dump |
| P2 Domain | state/policy/metrics/time + 单测 | policy 矩阵 100% | 纯新增 |
| P3 Services | 拆分、事务、条件更新、幂等、审计 | 5 缺陷回归测试；demo 通过 | re-export |
| P4 Enforcement | 运行时 policy、审批、预算、自验收 | 403/202/409 验收 | flag off |
| P5 Metrics | 实时指标 | AAO=N；无静态 metrics | 旧快照 |
| P6 Management | 创建/暂停/退休/改宪章/setup | 不依赖 seed | 页面回退 |
| P7 Auth | 登录、作用域、审计验证 | 401/verify | flag off |

工时：5–6 天；3 天版做 P0–P4。

## 8. 测试矩阵

- Unit：policy 矩阵、状态迁移、metrics、time。
- Integration：run/audit、idempotency、audit chain、migration。
- E2E：3 分钟 demo + 重复点击。
- CI：Postgres service + typecheck + lint + test + build。

每个 PR 的 DoD：typecheck/lint/test/build 全绿；修复有回归测试；demo E2E 通过；无新增 magic number / 固定 ID。

## 9. 验收标准

- 自验收 403；paused/retired 403。
- 超预算 202 + approval，不创建 run。
- external_action 自动创建 approval；approve 后可执行一次，第二次 409。
- 双 accept 409，记忆 +1；rollback proposed 409；双 exam 409。
- 同 Idempotency-Key 重放返回同一响应。
- AAO=N；审计链篡改可检出。
- 未登录 401；生产 reset 不可用。
- `/setup` 可创建 workspace。
- runtime 无 70/3/45/2.8/5/18/38 等机制常量（seed/tests/docs 例外）。
- 3 分钟 demo 通过。

## 10. 风险与回滚

| 风险 | 预防 | 回滚 |
|---|---|---|
| FK 孤儿 | 迁移前 orphan SQL | 恢复 dump |
| Policy 太严 | 种子 policy + flag | flag=false |
| 拆分循环依赖 | re-export + codegraph | 恢复 engine |
| 并发死锁 | 固定锁顺序 + advisory lock | 串行降级 |
| 指标争议 | formula_version | 旧快照 |
| Auth 阻塞 | demo login + flag | 关闭 middleware |
| 范围膨胀 | P0 冻结 | backlog |

停止条件：任一阶段 E2E 失败不进下一阶段；迁移失败不改生产库；测试 flaky 先修。

## 11. 不做

多用户协作、社区、marketplace、LLM 自动辩论、真实支付、链上身份、完整技能评测、移动原生、视觉重做。

---

## 实施进度（本次）

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 基线 | ✅ | 分支 `fix/mechanism-integrity`、tag `demo-v1`、DB dump、Vitest、CI |
| P1 Schema | 🟡 | additive 表/列、policy_config、agent_templates、idempotency_keys、user_actions 已加；**FK/约束未加**；迁移基线已生成，现有库仍用 push |
| P2 Domain | ✅ | state / policy / time + 单测；metrics 在 engine 内 |
| P3 Services | 🟡 | 条件更新、状态守卫、幂等（状态级）已做；engine 未拆分；runTask 未整体事务化；idempotency_keys 未接入 API |
| P4 Enforcement | ✅ | paused/self-audit/budget/approval/autonomy gate/连续驳回暂停 |
| P5 Metrics | 🟡 | AAO/依从性/管理时间/成本/驳回率实时；goal progress 仍来自 goals 表 |
| P6 Management | 🟡 | 新建目标/任务/会议、暂停/恢复/退休/改宪章/预算；新建 Agent 与 `/setup` 未做 |
| P7 Auth & Verify | 🟡 | 审计链验证已完成；鉴权/租户作用域/CSRF 未做 |

测试：82 tests（policy 30、state 15、time 5、integration 32）。
