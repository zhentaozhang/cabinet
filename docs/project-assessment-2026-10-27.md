# Cabinet 项目评估：机制、偏差与下一步

> 评估日期：2026-10-27　｜　基线：`main@1565102`（领先 `origin/main` 19 个提交）
> 方法：读 README / docs / 计划文档，逐条到代码取证；`tsc --noEmit` 通过；单测与集成测试抽样通过（见附录）。
> 口径：本文把「README 已披露的边界」和「实现与承诺不一致」分开写。前者是定位选择，后者才是偏差。

---

## 0. 结论摘要

1. **工程质量高于同类个人项目**：分层边界有测试强制、状态迁移有条件更新、预算有预留式台账、审计链可验证、崩溃有恢复路径。这些不是包装，是运行时真的执行的机制。
2. **最大的偏差不是「没写完」，而是「叙事比运行时大一圈」**：产品名与首屏暗示「七个 Agent 协作」，运行时是「单执行者 + 角色化提示词/模板」。README 已承认这一点，但界面与 charter 仍在暗示相反的预期。
3. **第二类偏差是「机制已实现、消费方没接上」**：知识点掌握度没有 API/页面、`rerank` 钩子没有生产调用方、非学习目标没有度量、18 个声明工具里只有 2 个内置执行器。这是同一个模式在不同层的重复。
4. **最需要立刻修的是语义完整性，不是功能数量**：`undetermined` 在 `checklistPassed` 里被当成通过；没有验收清单的任务仍会写成 `accepted`，报告却写「待你确认」；界面承诺「只有你能覆盖 Auditor」，但没有任何覆盖入口。这三条直接损害产品唯一的护城河——「结论可追责」。
5. **战略上应继续收窄，而不是扩张**：Cabinet 的独特位置是「任务级治理层」（预算、审批、独立验收、审计、manifest）。护城河的敌人不是缺生活模块，而是「治理着一批不会做事的 Agent」。优先级应是：先让工具调用真实发生，再把治理语义补严，最后才谈多 Agent 与生活域。

---

## 1. 项目实际是什么（用代码定义，而不是用口号）

一句话：**单用户、单执行者、以任务为单位的 Agent 运行治理层，外加一条真实运转的学习闭环。**

| 机制 | 真实实现 | 运行时边界 |
|---|---|---|
| 任务状态机 | `src/lib/domain/state.ts`，条件更新 + 409 | 完整；`running` 也可取消，同一事务关闭 run/job/预算预留 |
| 策略门禁 | `src/lib/domain/policy.ts:306 decideRun`，四态 `allow/suggest/require_approval/deny` | 完整；配置缺失 fail-closed |
| 预算 | `agent_budget_periods/reservations`，调用前预留、崩溃按未知结算 | 完整；成本是估算，不是账单 |
| 审批 | `approvals` + 单次消费 + 过期 | 完整；但几乎没有真实外部动作可批 |
| 独立验收 | 确定性清单 + 可选 `judge` 判卷 | 完整；未判定不阻塞（见 §2.2） |
| 审计链 | 每用户一条 SHA-256 前向链 | 完整；无外部锚定 |
| 学习闭环 | Check-in → 出题 → 判卷 → SM-2 掌握度 → 复盘 → 策略覆盖 | 完整；掌握度无独立视图 |
| 记忆 | 词面 + 3-gram + 时间衰减 + 重要度；冲突不覆盖 | 无 embedding；rerank 无调用方 |
| 内阁 | 规则生成 5 个立场；决议写程序记忆 + 跟进任务 | 不是 5 个模型各自研究 |
| 学徒 | 5 条观摩 → 确定性考试 → 练习通过 | 考试是模板产物 |
| 工具 | `TOOL_SPECS` 18 个；`web_search`/`web_fetch` 真实；MCP 动态工具 | 其余 16 个声明工具无执行器 |

规模基线（本次实测）：`src` 44,234 行 TS/TSX；48 个 `route.ts`；13 个 `page.tsx`；40 张表；133 个测试文件。`tsc --noEmit` exit 0；`tests/unit/state.test.ts` 25 passed；`tests/integration/task-lifecycle.test.ts` 5 passed。

**判断**：这套东西的重心是「结论可追责」，不是「过程可观测」，也不是「Agent 会自己干活」。所有后续分析都从这个事实出发。

---

## 2. 偏差分析：哪些是真偏差，哪些只是定位选择

### 2.1 叙事偏差：四个承诺大于运行时

| 承诺 | 证据 | 运行时实际 | 影响 |
|---|---|---|---|
| 「7 个角色」像 7 个 Agent | README 第 116–126 行；`seed.ts:196-345` | 只有 Coach（出题）、Auditor（验收）、Apprentice（考试）有真实分支；Chief 的「拆解与派活」是 `run.ts:480` 的一个字符串；Researcher 的工具来自 `agent.tools` 而非角色（`tool-plan.ts:5-8` 明确写了不用角色推导） | 用户按「组织」预期进入，看到的是「一个执行者换不同提示词」 |
| 「Chief 不亲自执行」 | `seed.ts:206` charter 原文 | 内阁批准后跟进任务的 `assigneeId` 就是 Chief（`council/decide.ts:98`）；Chief 也能被指派普通任务 | charter 与运行时直接矛盾 |
| 「只有用户能覆盖 Auditor」 | `seed.ts:294`；`cabinet/page.tsx:474` 再次展示 | 全仓没有任何 override 入口（`grep overrideAudit\|userOverride` = 0） | 这是界面在说一件不存在的事，性质比「未实现」更重 |
| 「自我学习与生活」 | README 标题与首屏 | 学习闭环是真的；「生活」只有 `goals.domain` 的标签，健康/日历目标没有度量。`progress.ts:30-40` 对非 learning 直接 return，真实工作区里新建的健康目标永远是 0%；演示数据里的 60% 只是 seed 常量，之后不会再变 | 产品承诺了一半没有运行时的领域 |

**纠正原则**：要么改叙事，要么补机制，不能继续让 UI 替不存在的机制说话。建议分两步：

1. **立刻（1 天）**：把 Cabinet 页的角色卡从「职责」改为「能力矩阵」——每个角色列出 `tools / grants / memoryScope / 已接入状态`，未接入的工具明确标注 `declared only`。charter 文案里删掉或标注未实现的承诺（尤其 Auditor 的覆盖句）。
2. **一个迭代（1–2 周）**：实现 `dispatch` 的真实语义——不是 Agent 间聊天，而是**可问责的交接**：父任务创建子任务，继承预算上限、证据与验收标准，链路上每一跳都有 assignee/auditor。这是与 CrewAI 式「群聊」完全不同的多 Agent，且与现有治理模型同构。

### 2.2 语义偏差：最严重的一类，直接伤害护城河

这三条不是功能缺失，是「结论与证据不一致」，正是 `AGENTS.md` 第 2 条要防的那类问题。

**(a) `undetermined` 被当成通过。**
`src/lib/domain/acceptance.ts:189-193`：

```ts
export function checklistPassed(results: AcceptanceResult[]): boolean {
  return results.every(
    (result) => !result.item.required || result.passed || result.undetermined,
  );
}
```

后果：一张只有 `judge` 项的清单，在没有配置模型时全部 `undetermined`，任务仍然 `accepted`，reason 写「另有 1 项未判定，未计入本次结论」。**「没有结论」被状态机读成了「通过」。** 更值得注意的是，`countsAsEvidence` 成立时信任分仍 +1（`audit.ts:450-470`）——只要模型真的跑过、产物是 `model_generated`，即使唯一的实质判卷项没判，Agent 仍能积累晋升证据。

**(b) 没有验收清单的任务仍会 `accepted`。**
`audit.ts:256-281` 写了一条 `undetermined: true` 的人工项，reason 是「需要你人工判定」，但 `pass = artifact.content.trim().length > 0`，随后状态写成 `accepted`。页面会同时显示「已通过」和「待你确认」。

**(c) 承诺了覆盖入口，但没有实现。**
见 §2.1。把 (a)(b)(c) 合起来看，正确解法是同一个：**引入 `needs_review` 状态**。

```
submitted → auditing → accepted | rejected
                    ↘ needs_review（存在 required 且 undetermined 的条目）
                         ↓ 用户判定（必须填理由）
                    accepted | rejected
```

- `needs_review` 是唯一合法的「用户覆盖 Auditor」入口，正好兑现 charter 与 UI 的承诺。
- 用户判定写 `audit.override` 审计事件，记录 before/after、理由、被判定的 `artifactId`。
- 用户覆盖不增加 Agent 信任分（覆盖不是 Agent 的证据）。
- 没有清单的任务一律进 `needs_review`，不再自动 `accepted`。

验收标准：judge-only 清单在无模型时停在 `needs_review`；用户填理由后可 accept/reject；审计链出现 `audit.override`；信任分不变；现有 133 个测试文件中受影响的用例有明确更新。

### 2.3 闭环偏差：机制已实现，消费方没接上

这是本仓库反复出现的模式（`docs/backend-chain-review.md` 称之为「只写不读的落地物」），目前仍有四处：

| 能力 | 已实现 | 缺什么 | 证据 |
|---|---|---|---|
| 知识点掌握度 | `mastery.ts` 的 SM-2 排期 + `listMastery()` | API 与页面 | `listMastery` 只有定义，无调用方；导航只有 6 个入口，没有 Learning |
| 记忆重排 | `retrieval.ts:202` 的 `rerank` 钩子 | 生产调用方 | `run.ts` 调 `retrieveMemories` 时不传 `rerank`；没有 key 时路径与旧版一致，但也没有本地重排 |
| 任务经验 → 记忆 | `writeMemoryFact` 存在 | 验收后不写任务记忆 | 只有 check-in、洞察采纳、内阁决议、异议判定四处写入；一次被驳回的任务不会留下任何可检索的教训 |
| 非学习目标进度 | `goals.progress` 字段与 UI | 任何度量方式 | 非 learning 目标不被重算：真实工作区新建后恒为 0%，演示数据停在 seed 的 60%；`progress.ts` 明确只服务 learning |

**纠正**：

1. **掌握度（1–2 天）**：加 `GET /api/learning/mastery`，在 Review 或 Today 增加「到期复习 / 掌握度」卡片。服务层已就绪，这是纯接线。
2. **记忆吸收任务结果（2–3 天）**：验收通过/驳回时写一条 `semantic` 或 `procedural` 记忆，`factKey = task:<id>:lesson`，证据指向本次 `artifactId`，置信度取审计结论。这样「做过的事」才会进入下一次检索。
3. **rerank（0.5 天）**：`run.ts` 在配置了模型时传一行 `rerank`；没有模型就保持现状，不引入新依赖。
4. **非学习目标（决策点）**：要么删掉「生活」表述，要么给非学习目标一个诚实的度量——每周用户自评 0–100，写入 `goals.progress`。**不要用一个学习公式去猜健康目标的进度**，这正是 P0-3 修过的 bug。

### 2.4 执行面偏差：治理着一批不会做事的 Agent

- `TOOL_SPECS` 声明 18 个工具（`tool-plan.ts:16-35`），真正有执行器的只有 `web_search` / `web_fetch`，外加运行时发现的 MCP 工具。`dispatch`、`budget_veto`、`convene_council`、`calendar_read`、`ledger_read`、`sandbox_execute` 全部走 `not_connected`（`run.ts:627`）。
- 后果一：Vault 的 charter 说「任何超预算的计划，我会否决」，但 `budget_veto` 没有执行器——真正拦下超预算的是 `policy.ts`，不是 Vault。
- 后果二：`awaiting_approval` 是这台机器最值钱的状态分支，但真实工作区里几乎没有对象可批。审批流程只有在演示数据里才显得完整。
- 后果三：七个角色的差异只能落在提示词里，不能落在「能调什么」里。这与 README 自己写的「charter 不是可执行约束」一致，但产品叙事没有跟上。

**纠正顺序**（不要一次全接）：

1. 先做 **capability registry**：给每个 `TOOL_SPEC` 加 `implemented: boolean` 与 `executor: string | null`，UI 与 step 输出都读它。这样「声明」与「可用」永远不会再混。
2. 接 **calendar_read**（MCP，只读）——让 Researcher/Coach 第一次真的读到外部数据，且不扩大写攻击面。
3. 再接 **calendar_write**（MCP，写）——让审批第一次有真实对象；批准后执行一次、消费一次、写证据。
4. `sandbox_execute` 明确不做，并在 UI 标注「未接入」，不要留一个看起来能用的按钮。

### 2.5 交付偏差：门禁与文档

- **CI 仍然没有 push 触发**：`gh api .../actions/runs` 最近 5 条全是 `workflow_dispatch`（2026-10-24），而本地 `main` 已领先 `origin/main` 19 个提交。也就是说：既没有推送，也没有云端门禁。`docs/ci-status.md` 的诊断仍然成立。
- **没有浏览器 E2E**：`scripts/e2e-probe.ts` 是 HTTP 探针，不是 UI 回归；任务页 1,230 行、Today 906 行，没有组件级视觉回归。
- **文档计数漂移**（本次实测）：
  - README 第 224 行「47 个 route」→ 实际 48；
  - README 第 240 行「35 张表」→ 实际 40（新增 learning_topics / learning_mastery / learning_attempts / policy_overrides / mcp_servers）；
  - README 第 12 行「外部服务尚未接入」与第 289 行「只有检索是真的」自相矛盾；
  - README 第 23 行「每次运行最多一次文本生成」与第 114 行「模型自选工具每次调用都是独立计费请求」矛盾；
  - README 第 121 行「按角色选择 web_search」与 `tool-plan.ts` 的「never from the agent's role」矛盾；
  - README 第 141–142 行 Settings 重复两行。
- **依赖卫生**：`date-fns` 在 `src` 中零引用。

**纠正**：写一个 `scripts/doc-facts.ts`，从代码计算 routes/tables/tests 并生成 README 的事实块；CI（或 `pnpm verify`）在数字不一致时失败。这个仓库的品牌是「文档与实测对齐」，用手写数字维护它是反的。

---

## 3. 优化清单（按杠杆排序，不按工作量）

### P0：先修语义，再谈功能（3–5 天）

| # | 事项 | 产出 | 验收 |
|---|---|---|---|
| 1 | `needs_review` 状态 + 用户覆盖入口 | 状态机、`POST /api/tasks/[id]/override`、任务页按钮、`audit.override` | judge-only 无模型 → `needs_review`；填理由可覆盖；信任分不变 |
| 2 | `checklistPassed` 不再把 undetermined 当通过 | 纯函数 + 调用方 | 受影响测试更新；无清单任务不再自动 accepted |
| 3 | 角色卡改为能力矩阵，删掉未兑现的 charter 句 | Cabinet 页 + seed 文案 | 页面不再出现「只有你能覆盖」而没有入口 |
| 4 | 推送 19 个提交；跑一次 `pnpm verify`；按 `docs/ci-status.md` 做下一次 push 实验 | 远端与 CI 证据 | `gh api` 出现 `push` 行，或明确记录仍不触发并加 pre-push hook |

### P1：把「已实现」接到用户面前（1–2 周）

| # | 事项 | 为什么现在做 | 验收 |
|---|---|---|---|
| 5 | 掌握度 API + 页面/卡片 | 服务层已就绪，纯接线；这是学习闭环唯一缺的出口 | 3 次复习后能看到每主题间隔、下次到期日、正确率 |
| 6 | 验收后写任务记忆 + `rerank` 调用方 | 让「做过的事」进入下一次检索，而不是只记打卡 | Memory 页出现任务来源的记忆；相关查询能召回 |
| 7 | 非学习目标的诚实度量（或删「生活」） | 消除「健康目标永远 0%」的假语义 | 健康目标只在用户自评后变化 |
| 8 | capability registry + `calendar_read`（MCP） | 第一次让「外部世界」进入治理链 | 运行 step 显示真实读取；未接入工具显示 `declared only` |
| 9 | 文档事实块自动化 | 防止计数继续漂移 | `pnpm verify` 在数字不一致时失败 |

### P2：把治理做成产品（2–4 周）

| # | 事项 | 说明 |
|---|---|---|
| 10 | 策略 dry-run / 解释器 | 复用纯函数 `decideRun`，点运行前展示「会被哪条规则拦、缺什么才能放行」 |
| 11 | 验收标准回放（criteria drift） | 用当前清单重跑历史产物，回答「如果今天用这份标准，过去 10 个产物会有几个不通过」 |
| 12 | 单位经济学 | 每个被验收产物的成本、驳回造成的浪费、预算利用率、审批等待时长 |
| 13 | Auditor 记分卡 | 通过率、被用户覆盖率、未判定率、平均验收时长；「审计审计者」 |
| 14 | 可问责交接链 | 父任务 → 子任务，继承预算/证据/验收；这才是「多 Agent」的正确形态 |
| 15 | 浏览器 E2E（3 条主路径） | Today 跑任务→验收；Check-in→下一题；内阁决议→跟进任务 |

---

## 4. 强化：已有资产里最值得放大的五件事

1. **预留式预算台账**。LiteLLM 是事后统计，Cabinet 是准入控制 + 崩溃按未知结算。这个差异应该出现在首屏，而不是藏在 `docs/run-durability.md`。
2. **独立验收 + `undetermined` 三态**。这是「不伪造结论」的机制化表达。修好 §2.2 之后，它可以成为对外协议，而不只是内部规则。
3. **可离线验证的 manifest**。`run.manifest.json` + Merkle + 审计链头已经能证明「这份产物是那次运行产出、按这份清单验收」。缺的只是外部锚定与一个更容易理解的入口。
4. **学习闭环的 SM-2 变体**。到期优先、答错压回 1 天、判卷未判定不推进掌握度——这套细节比大多数「AI 学习助手」认真。
5. **内阁异议的事后判定**。`dissents` 会在观察窗口到期后由 `pnpm tick` 判定谁对。这是「内阁」唯一真正区别于「让 5 个模型各说一段」的机制。

---

## 5. 亮点与创新：五个别人没做或做得更弱的方向

| # | 想法 | 为什么独特 | 成本 | 依赖 |
|---|---|---|---|---|
| ★1 | **策略 dry-run / 解释器** | 所有 Agent 框架都能「运行」，没有一个能在运行前用业务状态解释「为什么这次会被拦、缺哪张审批、还差多少预算」。`decideRun` 已是纯函数，几乎是免费的差异化 | 低（3–5 天） | 无 |
| ★2 | **验收标准回放与漂移检测** | promptfoo 能测提示，没人测「验收标准本身是否稳定」。用历史产物重跑当前清单，能回答「标准变严了吗、谁会被误伤」 | 中（1 周） | 现有 `evaluateAcceptance` + artifacts |
| ★3 | **单位经济学：每个被验收产物的成本** | 预算通常是「别超」，Cabinet 可以回答「这次学习任务花了 ¥0.42，被驳回两次，单次有效成本 ¥1.26」。这是管理台而不是监控台 | 低（3–5 天） | 账本 + tasks |
| ★4 | **审计审计者（Auditor scorecard）** | 独立验收只解决了「执行者不能自审」，没解决「审计者是否可靠」。用用户覆盖率、未判定率、事后异议判定做校准，几乎无人做 | 中（1 周） | §2.2 的 `needs_review` |
| ★5 | **可问责交接链（不是群聊）** | CrewAI/AutoGen 的多 Agent 是对话；Cabinet 可以是「每次交接都有 owner、预算、证据、验收」的链。与治理模型同构，且能解释「为什么这一跳失败了」 | 高（2–3 周） | `dispatch` 执行器 |

如果只能做一个：**★1**。它最便宜、最可见，且直接强化「治理层」的定位。

---

## 6. 建议路线图（4 周）

| 周 | 内容 | 判定标准 |
|---|---|---|
| W1 | P0 全部：`needs_review` + 覆盖入口 + 语义修正 + 角色卡 + 推送/CI 实验 | 无「未判定=通过」路径；页面承诺与入口一致；远端有提交 |
| W2 | P1 接线：掌握度页面、任务记忆、非学习目标、capability registry | 三个「已实现无入口」清零 |
| W3 | 执行面：`calendar_read` MCP；策略 dry-run | 审批第一次有真实对象；运行前能解释拦截原因 |
| W4 | 亮点：criteria drift + 单位经济学 + E2E 3 条 | Review 页能回答「标准是否稳定、钱花得值不值」 |

---

## 7. 反面意见与边界

1. **不要变成第 N 个 Agent 框架**。编排层已有 40k–70k★ 的对手，Cabinet 的胜算在「别人不愿意做的脏活」：审批、预算、验收、审计、崩溃结算。
2. **不要做聊天入口**。`docs/superpowers/specs/2026-10-23-frontend-workspace-design.md` 已经明确拒绝「对话优先」，理由是「界面承诺超过实际能力」。这个判断今天仍然成立。
3. **不要为了「多 Agent」而多 Agent**。如果没有 `dispatch` 的真实语义，七个角色只是七段文案；与其加角色，不如让现有角色的工具真的可用。
4. **复杂度预算**：44k 行、133 个测试文件、单个 1,152 行的 `run.ts`。继续加机制前，先把 `run.ts` 按「认领 → 计划 → 执行 → 落库 → 结算」拆成有类型的结果阶段；否则下一次改动会继续在长函数里做条件分支。
5. **哈希链的信任边界要说清**：它能证明「库内未被静默改写」，不能证明「有权限的人改不了」。对外宣称前必须保留这句话。

---

## 附录：本次核查命令与结果

| 命令 | 结果 |
|---|---|
| `git log -1` | `1565102`，2026-10-26 16:04 +0800 |
| `git status -sb` | `main...origin/main [ahead 19]` |
| `find src/app -name route.ts \| wc -l` | 48 |
| `find src/app -name page.tsx \| wc -l` | 13 |
| `grep -c pgTable src/lib/db/schema` | 40 |
| `find tests -name '*.test.ts' \| wc -l` | 133 |
| `wc -l src/**/*.ts*` | 44,234 |
| `tsc --noEmit` | exit 0 |
| `vitest run tests/unit/state.test.ts` | 25 passed |
| `vitest run tests/integration/task-lifecycle.test.ts` | 5 passed |
| 全量 `vitest run` | 本次会话 13 分钟未跑完（串行 + 每轮克隆库）；仓库文档记录为 1,255 passed，未在本次复核 |
| `gh api .../actions/runs` | 最近 5 条均为 `workflow_dispatch`，无 `push` |

---

# 2026-10-28 复核：上一轮清单的落地情况

> 复核基线：`main@bfde7e9`（已推送，工作区干净）。本次只读复核 + 抽样跑测试，不改业务逻辑。
> 结论先行：**上一轮 P0 的三条语义问题已全部修好，P1 的「已实现无入口」也大部分接上了；剩下的是三处新暴露的语义缺口，以及原清单里未动的四项。**

## 8.1 状态总表

| 上轮建议 | 状态 | 证据 |
|---|---|---|
| `needs_review` 状态 + 用户覆盖入口 | ✅ 已完成 | `state.ts` 新增 `auditing → needs_review → accepted/rejected`；`override.ts` 理由 5–500 字、条件写回 409、`audit.override`、不动信任分；`POST /api/tasks/[id]/override`；任务页 `decision-card.tsx`；`tests/integration/audit-override.test.ts` 455 行 |
| `checklistPassed` 不把 undetermined 当通过 | ✅ 已完成 | `acceptance.ts:206 auditVerdict` 三值；`checklistPassed` 改为 `=== "pass"`；无清单分支改为 `needs_review`（空产物/缺 rubric 仍判 `fail`） |
| 角色卡改能力矩阵 | ✅ 已完成 | `tool-plan.ts` 每个工具带 `implemented`；`/cabinet` 用实线/虚线/红色区分「已实现 / 声明未接 / 未注册」；`tests/unit/capability.test.ts` 180 行 |
| 推送 + CI 实验 | 🟡 部分 | 已推送 3 次（`1565102 → 36ff2a0 → ff4c8e9`）；**push 仍不触发 workflow**，手动 dispatch 在 `36ff2a0` 全绿；`docs/ci-status.md` 记录三次实验与两条未定因 |
| 掌握度 API + 页面 | ✅ 已完成 | `GET /api/learning/mastery` + `/review` 的 `mastery-card.tsx`；到期数单独 count，`isDue` 用数据库时钟；`tests/integration/mastery-api.test.ts` 161 行 |
| 任务经验写记忆 | ✅ 已完成 | `task-lesson.ts`：`factKey=task:<id>:lesson`、同值只刷新、结论变化走 supersede；验收与 override 都写 |
| `rerank` 生产调用方 | ❌ 未做 | `retrieval.ts` 仍有钩子，`run.ts` 仍不传；无本地重排 |
| 非学习目标度量 | ❌ 未做 | `progress.ts` 仍对非 `learning` 直接 return；健康目标仍无度量 |
| `calendar_read`（MCP） | ❌ 未做 | 注册表把它标成 `implemented: false`，至少现在**诚实**了 |
| 文档事实门禁 | ✅ 已完成 | `scripts/doc-facts.ts --check` 通过（routes=51, tables=40, testFiles=142, testCases=1233）；已进 `verify.sh` 与 CI |
| 策略 dry-run | ✅ 提前完成 | `policy-explain.ts` 331 行；`GET /api/tasks/[id]/policy-preview` 与执行共用 `run-context.ts`；守卫测试防止两边重新分叉 |
| 验收标准回放 / 单位经济学 / Auditor 记分卡 / 可问责交接 / E2E | ❌ 未做 | 仍在上轮 P2 |

## 8.2 这一轮新暴露的三个语义缺口

### (a) 用户判定没有回写到验收报告，页面仍说「需人工复核」 [已修，见 8.6]

`override.ts` 只改了 `tasks.status` / `acceptedAt` 并写 `audit.override`，**没有动 `acceptanceReport`**。任务页的清单仍按 `acceptanceReport[index]` 渲染（`page.tsx:123`），所以一个已经被用户判定为 `accepted` 的任务，验收卡片仍会显示「需人工复核 (1 项)」，理由也不在页面上——只能去 `/review/audit` 里翻。

这不是「报告造假」，而是**同一个任务有两套说法**：状态说通过，报告说没人判。建议二选一：

1. **不改报告，加一条人判记录**：任务查询读该任务最新的 `audit.override`，在验收卡片上方渲染「Auditor 未给出结论；用户于 X 判定通过，理由：…」。保留 Auditor 报告的原始性，同时让页面只有一个故事。
2. **改报告，但标明作者**：给 `AcceptanceResult` 加 `decidedBy: "auditor" | "user"`，override 时把 required 且 undetermined 的行替换成 `passed: decision==="accepted"`、`decidedBy: "user"`、`reason: note`。报告仍是「逐条」，但每条都说得清是谁判的。

推荐 1，成本更低，且不触碰 Auditor 报告的语义。

### (b) 用户判定不推掌握度，离线学习闭环仍然不排期 [已修，见 8.6]

`audit.ts` 在 `needs_review` 时跳过 `recordOutcome`（这是对的：没有结论不能假装复习过）。但 `override.ts` 也只写任务记忆、不写掌握度。于是：

- 到期复习题一定带 `judge` 项（`learning.ts:95-99`）；
- 没配模型时判卷项永远 `undetermined` → `needs_review`；
- 用户判定通过后，掌握度仍不前进，`due_at` 不变。

结果是：**没有 API key 的用户，到期复习的间隔永远不会前进**——`due_at` 停在过去，同一主题会被反复判定为「到期」，SM-2 的阶梯对离线用户完全失效。这与「模型调用可选」的产品承诺冲突。

关键区分：信任分是 **Agent 的证据**，掌握度是 **学习者的状态**。人的判定不该给 Agent 加分，但它恰恰是学习者最权威的结论。建议在 `override.ts` 里对 `isLearningTask && task.topicKey` 调用 `recordOutcome`，并给掌握度行加 `source: "user"`（或复用现有字段标注），让离线路径也能推进 SM-2。

### (c) 判卷的模型调用不进预算台账

`judgeAnswer` 返回 `tokensIn/tokensOut`（`llm.ts:318-319`），但 `JudgeOutcome` 没有 usage 字段，`audit.ts` 的审计 run 固定写 `costCents: 0`、`tokensIn: null`。也就是说：**一次真实的模型调用，在「预留式预算」的账本上完全不存在**。

这正好落在产品最在意的语义上：预算闸门只覆盖 Agent 运行，不覆盖判卷。建议：

1. `JudgeOutcome` 增加 `usage`，`audit.ts` 把它写到审计 run 的 `tokensIn/tokensOut/costCents`（按现有单价换算）；
2. 更彻底：判卷前从 Auditor 的周预算预留，失败按未知用量结算，与 `run.ts` 同构。

## 8.3 其他仍然开放的点

- **Chief 的 charter 与运行时仍矛盾**：`seed.ts:206` 写「我不亲自执行」，但内阁跟进任务的 `assigneeId` 就是 Chief（`council/decide.ts:99`）。要么改文案（「我不执行具体任务，但内阁决议的跟进由我牵头」），要么改指派。
- **步骤 token 是编造的**：`audit.ts` 的 `addStep` 固定写 80/40，`run.ts` 的 context/plan 步骤写 220/380/120；run 级 usage 是真实的（或 null），step 级不是。建议确定性步骤写 0 并加 `measured: false`，或在 UI 标注「估算」。
- **任务记忆的兜底领域是 `learning`**：`task-lesson.ts` 对没有目标的任务写 `domain: "learning"`，会让通用任务的教训进入学习记忆范围。建议兜底为 `task` 或 `general`。
- **README 的「1335 passed」已过期**：最新提交记录 1347；doc-facts 只校验声明数（1233），不校验 passed，这是刻意取舍，但这句话本身仍在漂移。
- **`date-fns` 仍零引用**；**Agent 创建入口仍不存在**；**「生活」域仍无度量**；**浏览器 E2E 仍没有**。

## 8.4 本轮验证

| 命令 | 结果 |
|---|---|
| `tsx scripts/doc-facts.ts --check` | ok（routes=51, tables=40, testFiles=142, testCases=1233） |
| `vitest run`（8 个新测试文件） | 8 files / 72 passed（needs-review、audit-override、mastery-api、task-lesson、policy-preview、capability、doc-facts、policy-explain） |
| `tsc --noEmit` | exit 0 |
| `gh` 最近 run | `40532066501`（workflow_dispatch，headSha `7678b8b`，success）；三次真实 push 均未产生 `push` run |

## 8.5 更新后的优先级

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | (a) 用户判定回写/展示 + (b) 掌握度在 override 时推进 | 两者都是「结论已经给出，系统却不认」；修完这一轮才算真正闭环 |
| P0 | (c) 判卷用量记账 | 预算台账是护城河，不能对一次真实模型调用视而不见 |
| P1 | 非学习目标度量、`calendar_read`、`rerank` 调用方 | 仍是「已实现无入口/无对象」的三处 |
| P1 | 浏览器 E2E（3 条主路径） | 142 个测试文件仍没有一条穿过真实 UI |
| P2 | criteria drift、单位经济学、Auditor 记分卡、可问责交接 | 上轮亮点，仍未动 |

## 8.6 本轮修复：(a) 与 (b) 已落地

采用 (a) 推荐方案 1：不改 Auditor 的报告，另给人判一条记录。

- **数据**：`getTaskData` 单独查一条 `audit.override`（`src/server/services/queries/task.ts`，按 `seq desc` 取最新），而不是从任务页那 10 条审计时间线里筛——人判之后再记任何事件，判定记录都会掉出窗口。DTO 新增 `TaskPageDto.override`（`{decision, reason, artifactId, decidedAt}`，`src/contracts/dto/entities.ts` 的 `taskOverrideRecordSchema`）。
- **映射不许猜**：`toOverrideRecord`（`src/server/mappers.ts`）读不懂的 `after` 一律返回 `null`，不在页面上凭空显示"已通过"。
- **页面**：任务页验收卡片上方渲染一张「你的判定」卡（结论徽章 + 理由 + 判定时间 + 被判产物），并写明下面的清单仍是 Auditor 当时的结论、这次判定不计入 Agent 信任分。
- **(b)**：`overrideAudit` 现在调用 `recordMasteryOutcome`（`src/server/services/commands/tasks/mastery-outcome.ts`，由 `audit.ts` 与 `override.ts` 共用同一处实现）——通过/驳回都会推进 SM-2 排期，信任分仍不动。抽成共享函数的原因是：分成两份时两条链路迟早对"什么时候推进排期"给出不同答案，而这次分叉的代价是离线用户的复习间隔永久停摆。
- **测试**：`tests/integration/audit-override.test.ts` 增 7 例（人判通过/驳回推进排期、非学习模板不写、无主题不造主题、页面带上判定、没判过是 null、追加 12 条审计事件后记录仍在），`tests/unit/override-record.test.ts` 5 例守"读不懂不猜"。
- **(c) 判卷用量记账仍未做**，仍按 §8.2(c) 的建议排期。
