# 长期策略：把一次批准变成有边界的规则

> 一次批准只值一次。但如果用户每次都要为同一类动作点「批准」，那"授权"就退化成"打勾"。
> 长期策略要解决的是**重复确认**，不是**放弃控制**。

## 一句话规则

**批准时勾选「记住这类决定」= 允许这一类动作在期限内自动执行；随时可撤销。**

它不会：
- 改变 Agent 的授权等级（L1 仍然是 L1，只能建议）；
- 取代基础权限（`agent_grants` 里按岗位下发的 `resource/scope` 仍然必须存在）；
- 覆盖 admin / audit 类动作——这两类永远逐次确认。

## 一条策略是什么

| 字段 | 含义 |
|---|---|
| `agentId` + `resource` + `action` | 只对**一个 Agent、一个资源、一类动作**生效 |
| `createdByApprovalId` | 由哪一次批准产生；没有这个字段的行是基础权限，不是策略 |
| `expiresAt` | 到期即失效（1–180 天） |
| `maxRuns` / `useCount` | 使用次数上限，默认 20；用尽后重新逐次确认 |
| `maxCents` | 只有花钱类动作必须填，单次上限 |
| `revokedAt` / `revokedReason` | 撤销时间与原因 |

同一个 `(agent, resource, action)` 只会有一条生效策略：再次批准会**取代**旧的那条（旧的被标记撤销，原因「被更新的批准策略取代」），所以任何时候都不需要比较两条规则谁更强。

## 判定顺序（`src/lib/domain/policy.ts` 的 `gate`）

1. 一次性批准且未消耗 → 放行（"用户已批准"）。
2. 一次性批准已消耗 → 看策略：命中则放行并记录 `standingGrantId`，否则拒绝。
3. 没有批准 → 命中策略则放行，否则维持 `require_approval`，由 Agent 发起新的审批请求。

`matchStandingGrant` 只处理 `require_approval`。`suggest`（L1 只能建议）永远不会被策略提升为放行——想让它执行，请调高授权等级，那是**另一个**决定。

## 使用与撤销

- 每次自动执行在同一个事务里做 `useCount = useCount + 1`，且条件写在 `WHERE` 里（未撤销、未用尽），所以并发两次运行不会都拿走最后一次额度。
- 每次使用写 `grant.use` 审计事件；创建写 `grant.create`；撤销写 `grant.revoke`。
- 撤销入口：`/cabinet/[id]` → 「工具与权限」→「长期策略」→ 撤销（两步确认）。撤销立即生效，下一次运行就会重新询问。

## 验证

```bash
node node_modules/vitest/vitest.mjs run tests/unit/standing-grants.test.ts \
  tests/integration/standing-policy.test.ts --maxWorkers=1 --no-file-parallelism
```

覆盖：命中/不命中、过期、次数用尽、撤销、花钱必须有上限、基础权限不算策略、拒绝不产生策略、未勾选记住时仍是单次批准。

## 边界（审查后补上的）

- **预算顶不破**：`spent + estimate > limit` 这一条永远逐次审批，长期策略不能替代它。旧的批准不投票给新的预算。
- **重叠时取最严**：两条策略同时适用时选剩余额度最紧的那条，而不是最宽松的——选宽松等于悄悄放大授权。
- **撤销立即生效**：`hasGrant` 与运行时加载都跳过 `revoked_at` 非空的行，包括基础的资源授权。
- **到期时间按用户时区显示**，不再直接截 UTC 日期。
