# Cabinet

> 自我学习与生活的多 Agent 管理台。
> 7 个角色、任务状态机、审批、独立验收、哈希链审计。

![Cabinet Today](public/today.png)

> 截图来自 seed 演示数据。

## 当前状态

可本地运行的 MVP。已经实现的部分集中在任务执行、审批、验收、审计链、记忆和复盘；模型调用可选。外部服务里只有检索（`web_search` / `web_fetch`，Brave，Tavily 兜底）是真的接通的，其余（日历、邮件、预订、支付）只声明未接，这些工具步骤记 `not_connected`。

## 这是什么

Cabinet 把「目标 → 任务 → 执行 → 验收 → 复盘 → 记忆」放进同一套状态机：

- 每个任务有一个执行者和一个验收者；执行者不能验收自己的任务。
- 执行前检查 Agent 状态、自主等级、资源授权、周预算和审批状态；周预算以台账预留的方式在调用模型之前发生。
- 验收使用确定性清单（章节、字数、来源数、关键词，或人工非空项），结果写入任务和运行记录。
- 关键状态变化写入 SHA-256 哈希链，可在 Review 页验证。
- 每日 Check-in 记录精力、情绪、学习时长、回忆正确率和错题标签；每周生成复盘和规则洞察。
- 模型调用可选：默认每次运行一次文本生成；判卷（temperature 0 的独立调用）和 `MODEL_TOOL_SELECTION=on` 时的模型选工具循环是额外调用，受配置与开关约束。不调用模型时可以使用显式演示模板。

设计假设：个人 Agent 的难点不只是生成内容，还有授权、验收、记忆和复盘。Cabinet 主要处理后者。

## 这不是什么

- **不是多 Agent 自治协作系统。** 一个任务只有一个执行者；Agent 之间没有消息传递、辩论或互相调用。内阁会议的五个立场由规则函数生成，不是五个模型各自研究。
- **不是模型训练系统。** 这里的“学习”指记忆、复盘、技能状态和任务结果，不更新模型权重。
- **不是外部执行器。** 没有日历、邮件、预订或支付连接器（检索是唯一接通的外部服务，见「已知边界」）；这些工具步骤在运行记录里写出 `not_connected`。
- **不是语义检索。** 记忆排序使用词面匹配、时间衰减和显著性，不是向量检索。
- **不是面向生产的 SaaS。** 没有计费、团队协作、配额运营或后台任务队列。

## 多 Agent 在这里指什么

不是七个独立进程，而是七个角色记录：

| 组成 | 说明 |
|---|---|
| 角色 | chief / researcher / coach / treasurer / auditor / apprentice / critic |
| 职责 | 写在 `agents.charter` 和 `objective` 里，用于界面展示和模型提示 |
| 权限 | `agent_grants` 决定能读写哪些资源 |
| 记忆范围 | `memory_scope` 决定能检索哪些领域的记忆 |
| 预算 | `budget_cents` 是每周模型用量的上限快照；实际账目在 `agent_budget_periods` / `agent_budget_reservations` |
| 自主等级 | L1–L3，由 `policy_config` 和 `agents.autonomy_level` 决定 |

需要区分“文案”和“运行时”：

- `charter`、`objective`、`tools` 是文本/展示字段。`charter` 会进入模型系统提示，但不是可执行约束。
- 真正生效的是 `status`、`lifecycle_stage`、`autonomy_level`、`agent_grants`、`budget_cents`、`memory_scope`，以及任务的 `assignee_id` / `auditor_id`。
- 相对明确的角色分支是 Coach（下一道学习任务）、Auditor（验收）、Apprentice（考试/转正）；Chief 还会接收内阁决议的跟进任务。其余角色的行为主要出现在内阁规则和界面文案中，没有自动拆解、记账或独立批评的运行时逻辑；检索是任务声明的一个工具步骤（见「机制清单」），不是研究流程。

## 一次任务怎么走

```
创建任务（用户或 Coach 的学习任务）
  → 指定 assignee + auditor
  → 策略检查：状态 / 等级 / 授权 / 预算 / 审批
  → 运行（可选模型一次生成；或 DEMO_MODE 模板）
  → 产物 + 运行步骤
  → 提交
  → Auditor 按清单验收
  → accepted / rejected / needs_review
  → done（用户确认或 Check-in 勾选）
```

- 外部动作和花钱：`external_action` / `spend` 会进入审批；批准后仍只执行同一套产物生成，不会真的预订或支付。
- 三个结论，不是两个：`accepted`（通过）、`rejected`（明确不合格）、`needs_review`（清单里必须判定的条目没有人能给出结论，例如没配模型的 `judge` 项、或者根本没有清单）。第三种既不是通过也不是驳回，任务停在「待你判定」，不动执行者的信任分、不加掌握度、不发驳回邮件。
- 人给的结论：`needs_review` 的任务只能由用户在任务页判定（`POST /api/tasks/:id/override`，`audit.override`）。理由必填（5–500 字），结论按条件写回（并发时后到的那次得到 409）。用户的判定**不**改变 Agent 的信任分——人的覆盖不是 Agent 自己的证据；但它会推进知识点掌握度并留一条任务记忆：掌握度记的是学习者的状态，人给出的结论恰恰是它最可信的输入（不推的后果很具体：没接模型时到期复习题永远停在"待你判定"，判通过后 due_at 仍留在过去，同一主题天天被判为到期）。
- 驳回：执行者的 `reject_streak` 加一；达到阈值（默认 2，可被采纳的洞察覆盖）自动暂停 Agent 并记一条 `agent.paused`，是否重新启用或退休由用户决定。内阁页的制度栏印的就是这个阈值——它读用户自己的策略值，不写死默认值。
- 通过：Agent 执行者的信任分 +1；驳回 -2。用户自己提交的验收不改变信任分，只有“真实模型运行 + Agent 产物 + 任务已验收”同时成立才计入晋升证据，而且看的是**产出这份产物那条 run**（重跑一次却在中途失败，不会把上一次真跑过的成绩抹掉），以及**这条结论当时判的那份产物**（审计行里记着 `artifactId`；之后又交了一版产物，不会把已经成立的那次判定改判成「没有证据」）。
- 关键写操作在事务里完成；写请求支持 `Idempotency-Key` 去重。

## 学习循环

```
每日 Check-in
  精力 / 情绪 / 学习分钟 / 回忆正确率 / 错题标签
        ↓
Coach 生成下一道学习任务
  （已有进行中的学习任务时直接复用）
        ↓
用户作答或 Agent 生成 → 提交
        ↓
Auditor 按清单验收（章节 / 字数 / 关键词 / 来源 / 模型判卷）
        ↓
目标进度 + 周复盘
        ↓
规则洞察 → 采纳 / 回滚 → 写入记忆
```

- 学习目标进度（默认权重）= 学习任务验收比例 × 0.5 + 最近回忆分 × 0.3 + min(本周打卡次数 / 5, 1) × 0.2；权重和目标打卡数在 `policy_config.learning`。"验收比例"的分母是排出去的任务（含还没做的），但不含已取消的任务——取消是终态，把它留在分母里等于让进度被一条自己撤回的题永久按住。"最近回忆分"取的是最近一次**记下了分数**的打卡：回忆正确率是选填项，把当天的打卡再存一次、留着这一栏空，不该把上一个真实的分数清零（没测 ≠ 测出来 0%）。
- 目标进度只有学习目标在算：`recalculateGoalProgress` 进门先看 `goals.domain`，不是 `learning` 就直接返回，其他域（健康 / 工作 / 生活）的 `progress` 从创建起就是 0（种子里那个健身目标是写死的 60，见 `src/lib/db/seed.ts:532`）——所以首页不再给它印百分比：目标卡读「—」并说明这类目标不按任务推算，页头那句主目标和早报模板同理。快速创建里的「关联目标」也只记归属：它产生的任务 `template` 是 null（`src/server/services/commands/tasks/create.ts:170`），不进学习任务的分母，不会移动任何数字，原来说的「计入目标进度统计」并不成立。内阁也是同一条口径：Chief 只有在学习目标上才引用百分比，其他目标改说「进度没有在算」、证据只记归属；可行性打分也不再拿这个冻结值加权（`goalProgressSignal`，未知进度那一项不参与）。
- 知识点掌握度：每道学习任务绑定一个知识点（`tasks.topic_key`），验收结论回写 `learning_mastery`，用 SM-2 变体排下次复习——答对走 1 → 3 → round(间隔 × ease) 递增（ease 从 2.5 起，每次 +0.1、夹在 1.3–2.8，间隔上限 60 天），答错把间隔压回 1 天且 ease −0.2。出题时**到期的知识点优先**，标题写成「复习：<知识点>」。
- 重测：上次学习任务验收通过 ≥ 3 天，且最近 Check-in 有错题标签时，下一题标记为 `learning_retest`。
- 判卷：清单里的 `judge` 项（"能用自己的话解释 X"）在验收时交给模型判定；没有配 `OPENAI_API_KEY` 时保持"未判定"而不是自动通过，超时/解析失败同样降级为未判定并写明原因。未判定的条目不算失败（任务仍可验收），但审计结论会写明"另有 N 项未判定，未计入本次结论"，学习任务在判卷项未判定时也不推进知识点掌握度——没有结论就不假装复习了一次；之后由用户判定时再补这一次（见上文"人给的结论"）。
- 早报和周复盘是确定性模板，不调用模型。早报正文与它下面的徽章都取自生成那一刻的读模型（徽章的「N 个待推进任务」读的是存下来的快照，不是页面此刻的任务数）；之后任务有变动不会改写早报，重新生成才更新。卡片的标题按这份早报自己的 `reviews.period`（本地日）说话：跨天没重跑时变「上一份早报 · 2026-10-28」并加一段说明，不再顶着「今天的关键判断」。正文里那三句口径由 `src/lib/presentation/brief-view.ts` 统一（第三句「需要你决定」是同一族：审批与内阁会议各自成项，都空时才说这两件事没有了，不替任务兜底）：目标行只列 `active` 的目标、非学习目标印「—」（与首页目标卡、页头同一判断），「今天有 N 个待推进任务」和「建议顺序」只取推进中的任务——失败和等审批的等的是人不是进展，既不计入数字也不被推荐成下一步；首页那条兜底早报与服务端的 `regenerateBrief` 调同一组函数，所以点「重新生成早报」不会写出与这一屏矛盾的正文（原来服务端自己 map 了每个目标、数的是整张任务表；兜底那一版还自己数了一遍审批、漏掉内阁会议，同一屏的行动队列却把它算进「待处理」）。
- 周复盘里的「目标进度」只报活跃的**学习**目标（这一屏的打卡、回忆分、学习任务、复测通过率全是学习口径）；没有活跃学习目标时显示「—」，不写「0%」——没有目标不等于目标零进度。原先取的是「随便一个活跃目标」，种子里同时有学习和健康两个目标时，同一周重新生成一次就可能换成另一个目标的数字。
- 反思从审计驳回、晚间完成率、低精力、预算压力和暂停 Agent 中找信号；一次生成一条洞察，可采纳或回滚。晚间完成率的分母只数**已经到点（今天及以前）且没撤回**的晚间任务：自己撤销的不算「没完成」（否则这条洞察会一直触发），排在明天或更晚的也还没到该做完的时候x略变更（`set_policy`），采纳后立刻改变后续任务的判定阈值；回滚把阈值恢复成 `policy_config` 里的默认值（同一 (用户, 键) 只保留一条 active 覆盖，历次改动留在审计链里）。「把晚间任务挪到高能时段」这类 `reschedule` 提案落到**下一次**那个钟点：今天还没到就是今天，已经过了就顺延到明天——照今天的钟点写会把任务当场写成几小时前就该做完的逾期项，而首页的「计划遵从率」正是按 `dueAt` 分分母的。
- 首页「资源消耗与核算」两列不是同一本账：左列读 `weeklyMetrics.costCents`（`agent_budget_periods` 的 settled + unknown），右列读 `retrieval_calls` 的 charged（按调用时快照单价）。开着 `MODEL_TOOL_SELECTION` 时，模型每选一次 `web_search` 都会按 `MODEL_TOOL_COST_CENTS`（3 分）先预留再结算进左边的预算台账（`src/server/services/commands/tasks/tool-loop.ts:668-733`），所以同一次检索会在两列各留一个数。卡片的说明由 `SPEND_LEDGER_NOTE` 统一给出，标题也从「模型推理费用 (Model Tokens)」改成「模型推理与工具预留 (Budget Ledger)」——原来那句「Token 消耗与外部检索属于两条独立曲线，并列展示不相加」等于说左列里没有检索的钱。
- `retrieval_calls` 里单价 0 有两种意思，统计时必须分开：按次计费的工具没被部署定价（`unpricedRequests`，首页写「N 次按次检索未计价（部署没配置单价）」），以及抓指名页面本来就不收费（`freeRequests`，写「N 次指名页面抓取不计费」）。`web_fetch` 的行恒为 0（`src/server/services/commands/tasks/run.ts:556` 与 tool-loop 的 `MODEL_TOOL_BILLABLE` 都传 `billable: false`），所以旧口径会让配了 `SEARCH_COST_CENTS_PER_REQUEST` 的部署在抓一次页面之后显示「本周检索未计价」。清单只有一份：`src/lib/domain/retrieval-billing.ts` 的 `METERED_RETRIEVAL_TOOLS`；文案由 `src/lib/presentation/today-view.ts` 的 `searchSpendLine()` 统一给出。

## 机制清单

| 机制 | 当前实现 | 边界 |
|---|---|---|
| 任务状态机 | planned → assigned → running → submitted → auditing → accepted / rejected / needs_review → done；外部动作走 awaiting_approval | 条件更新 + 409 冲突；needs_review 只能由用户判定带走 |
| 优先级 | `tasks.priority` 是名次不是分数：P1 最靠前。种子把今天的事记 1、明天记 2，内阁决议生成的任务是 1（`council/decide.ts`），新建任务默认 2 | Review 页的「下一周唯一目标」先按优先级挑、同优先才比截止日期；反着排会让 P1 的任务全被跳过，页面却仍说挑的是「优先级最高的」 |
| 策略门禁 | 状态、生命周期、自主等级、grant、周预算台账、审批 | 阈值来自 `policy_config`（可按用户被 `policy_overrides` 覆盖），缺失时 fail-closed；Agent 详情页「升级需要」那行由 `config.autonomy` 的四个数拼出来（信任分、成功任务、有效审计样本、**审计通过率**），不是写死的文案——漏掉通过率时，四条全达标却因一半产物被驳回而升不上去的人找不到原因 |
| 审批 | 外部动作 / 超预算进入审批；批准后消费一次 | 不执行真实外部动作 |
| 审批卡说的是哪一行 | 一条任务可以留下多行审批（`approvals.ts:49-50` 只对还 pending 的那行去重，以前运行花掉的批准以 `approved` 留在表里）：任务页横幅用 `pendingApprovalFor` 取真正在等你的那一行，卡片用 `pendingApprovalsFirst` 把待批排在最前，动作类型经 `actionTypeLabel` 印成「外部调用 / 产生花费」而不是枚举键，卡片标题在全部批完/过期后改称「审批记录」 | 原来横幅印的是 `approvals[0]`，而 `src/server/services/queries/task.ts` 的审批查询当时没有 `ORDER BY`——第二次审批请求之后，横幅念的是上一轮已经批过的那次动作和它的旧理由，同一张卡里却列着两行；动作类型直接印键（`external` / `spend`），`src/contracts/labels.ts:116-121` 专门提醒它是「最不该印成 `internal_read` 的字段」；批准一条「产生花费」的审批时，toast 还写「已批准外部动作」 |
| 验收 | 清单项：section / min_words / min_sources / min_evidence / contains / claims_table / manual / judge；页面把「未通过」与「需人工复核」分开数（`undetermined` 的条目 `passed` 也是 false，不能算失败）；驳回面板与顶部横幅按当前状态说话——重新提交后不再显示「被驳回」，人判驳回时署「你的驳回理由」、横幅也写「你驳回了当前产物」而不是 Auditor 的旧结论 | 除 judge 外都是确定性检查；required 项未判定时进入 `needs_review`，不冒充通过 |
| 验收由谁发起 | `submitted` 的下一步是「发起验收」，不是「等待验收」：`auditTask` 只由 `POST /api/tasks/[id]/audit`（任务页那颗「提交给 Auditor 验收」按钮）和学徒结业考试调用，`pnpm tick` 的维护任务里没有它；任务页横幅按 `canAudit`（`taskActions().audit.allowed`）分两句话——能点就请你按那颗按钮，没有验收者就说清楚它为什么按不了 | 没有守护进程：`submitted` 会一直停在原地。原来横幅写「Auditor 正在裁定、此时无需操作」，而同一屏右边就是那颗唯一的按钮，产物会无限期躺着 |
| 用户判定 | `needs_review` → 用户在任务页给出 accepted/rejected（`audit.override`，理由必填） | 不改信任分；判成 accepted 时当场重算目标进度（否则同一条数据会因下一次无关重算而变数）、把判卷历史里那次作答标成已接受（与 audit 回填同一字段，避免同一份作答两处说法相反）；推进知识点掌握度并写一条任务记忆；不写 `approvals`（那是执行授权，不是判定记录） |
| 复盘口径 | 页面用现在时说话的数字都按当前状态现算：待判定数只数此刻仍停在 `needs_review` 的任务（判定或放弃后立刻归零）、目标进度只取学习目标、「本周改了什么」里的已生效变更按采纳时间归周（`insights.decided_at` 落在本周，条数走整张 `insights`，列表只取最近几条、与洞察分页无关——三周前采纳的那条不会永远挂在这里，也不按 `created_at`：洞察常常是上周提出、这周才采纳）、计划遵从率的分母不含已撤回（`cancelled`）的任务、学习类任务数按验收时间归周（`tasks.accepted_at`，不按创建时间——上周布置、这周才验收的那道题，上周那篇复盘写不出来，这周再按创建时间挡掉，两篇都不提它）、复测通过率只数这一周**判过**的复测（结论来自审计行并按任务取最后一条：还没判的不进分母、撤回的不算没通过、跨周才判的那道算在判的那一周）、「回忆正确率」报的是本周打卡里你自己填的那个自评分（选填，没填就印「—」），不是复测判出来的分——复测通过率是另一个数，来源是审计行；「下周的唯一目标」只在还没了结的任务里挑，过滤与排序都在 SQL 里做（原来取的是「最近更新的 200 条」，任务一多，一条更早、优先级更高的未收尾任务会被新近收尾的任务挤出窗口，页面就印「没有未收尾的任务」） | 审计事件记录的是「曾经发生过」，不能直接当作「现在还剩多少」；一页装得下的东西也不能当成全集——同一周里复盘页与首页待办必须说同一件事 |
| 复盘叙事的归属 | 页头的周次用 `metrics.weekKey`（这一页的指标是哪一周的），「本周叙事」卡里的那条叙事则按它自己的 `reviews.period` 说话：跨周之后没重跑时标题变成「上一份复盘叙事（2026-W43）」，卡里加一段说明「上面的指标与本周改了什么都是本周现算的」 | `reviews` 按 (userId, type, period) 唯一，而 `regenerateWeeklyReview` 写的是「生成那一刻」的那一周（`reviews.ts:108`）；页面取的是最近一份（`review.ts:64-69`）。于是周一打开复盘页时，卡里躺着上周的叙事却顶着「本周叙事」，旁边六张指标卡和「本周改了什么」已经换成这一周的数字——两段时间被并成了一周。原来页头印的还是那份旧叙事的周期，读起来像整页都属于那一周 |
| 复盘叙事里的管理时间 | 那句「管理时间」是**这一周**的合计，不是每天的均值：实测分支是本周 `user_actions.duration_ms` 求和（`metrics.ts:179-188`），估算分支是本周人工决策次数 × `minutesPerDecision`；文案统一在 `src/lib/presentation/review-view.ts` 的 `managementTimeLine`，没有样本时写「本周还没有管理时间样本」而不是 0.0 | 原来写「约 X 分钟/天」，而 X 是周合计：种子里三条操作合计 2.8 分钟（`seed.ts:1774-1795`），于是印成「2.8 分钟/天」，读起来就是一周 19.6 分钟。这句话存进 `reviews.narrative` 后被复盘页原样印出，单位与口径只能在一处定义——改 `metrics.ts` 或改叙事任一处漏了另一处就会再次分叉 |
| 今日行动队列 | 「待处理」的构成 = 审批 / 内阁决议 / 待你判定的验收 / 被驳回 / 执行失败 / **等你采纳的建议**（`suggested`）；页头的「N 项任务推进中」「N 项待处理」与「其他推进中的任务」卡片都用 `src/lib/presentation/today-view.ts` 的一处判定，队列里的任务不再出现在下面的列表里 | 建议不是进展：L1 的 Agent 跑完只写一份草稿，任务页自己写着「等待你审核…由主理人确认采纳后方可继续」，把它列进「推进中」等于替用户宣称它自己会往前走（页头还会同时说「0 项待处理」和「1 项进行中」） |
| 运行前预演 | 任务页的只读面板：把 `decideRun` 的结论翻成「允许 / 需审批 / 拒绝 + 还缺什么」；失败 / 驳回的任务按「重试」口径预演（上次用掉的批准会被清掉、重新申请，所以是「需审批」不是「拒绝」） | 与真实执行读同一份基础策略、同一条重试判据（`isRetryExecution`）；不建预算周期行、不写任何状态。面板一直声称「和真正点运行是同一次判定」，而它原先独自决定「不处理重试」：那条已被消耗的批准在 `gate()` 里只会得到 `deny("Approval has already been consumed.")`，面板据此写「批准也解不开，必须改配置」，实际点下去却只是重新申请一次审批 |
| 分离职责 | 只有 auditor 角色、且不是 assignee，才能验收 | Auditor 放弃判定时由用户判定（`audit.override`），但用户的判定不进 Agent 的绩效 |
| 谁能接单 | 执行者下拉与 `createTask` 共用一条判据（`src/lib/domain/policy.ts` 的 `assigneeBlockReason`）：`retired` 是终态、学徒没转正（`shadowing` / `drafting` / `examining` / `practice_passed`）都不能执行，选项标「已退休，不能接单」/「未转正，不能接单」并禁用；暂停与考察期仍可排队，恢复在岗后任务就会跑起来 | `decideRun` 先看 `status`、再看 `lifecycleStage`，任一非 active 就在写任何 `runs` 行之前拒绝，任务永远停在 `planned`。原来下拉把所有 Agent 都列出来、执行预览还无条件写「将由 X 执行」：选了一个已退休的成员（或 `/setup` 建出来的默认学徒），任务建成功、永远跑不动。服务端只挡终态——一刀切拒绝非 active 会让「暂停 Coach」连带打断打卡排题（`checkins.ts` 的 `ensureNextLearningTask`）与内阁跟进任务 |
| 消耗卡的分担人数 | 消耗卡底部那行印的是「N 位**能接单的** Agent 共同分担本周的预算」，不是花名册人数：页面用 `assigneeBlockReason` 现算（与执行者下拉、`createTask` 守卫同一份判据），有不在岗或未转正的就补一句「另有 X 位不在岗或未转正，账上留着的是它们此前的花费」 | 首页的 `allAgents` 不过滤状态，原来直接印 `data.agents.length`：退休是终态（`src/lib/domain/state.ts` 的 `retired: []`）、学徒转正前也跑不了任何任务，它们不可能再往这本账里加钱。Cabinet 页头的 `agentHeadcount` 记的就是同一个错 |
| 通过率口径 | Agent 详情页与内阁列表卡片上的 Pass rate 都读同一个 `agentPassRate`：没有任何判定记录时印「—」（提示「还没有验收记录」），有记录才印百分比 | 0/0 不是一个比例：一次都没判过就印「0% · 验收通过率」，等于替这个 Agent 宣布「验收全没过」；复盘页对同一个数早就写「还没有验收记录」，metrics 里的遵从率/复测通过率/目标进度缺样本时也一律给 null 而不用 0 顶替。列表卡片曾经自己留了一份 `successRate`：新工作区里 7 个 Agent 一次都没判过，七张卡片同时印「0% · pass」，点进去却是「—」——同一个数在两页上说相反的话 |
| 预算框口径 | Agent 详情页「Weekly budget (¥)」框里填 0 不是「不许花钱」：`periodLimitCents` 把它读成「不单独给这个 Agent 设上限、只受部署级 `budget.weeklyLimitCents` 约束」，也就是最宽的那个额度。框下面那行字按这一周真正生效的上限（`min(该 Agent 预算, 策略上限)`）把 0 说清楚；清空或填不出金额时保存被 `yuanToCents` 拦下，不再把空字符串当 0 提交 | 模板里 chief / treasurer / auditor / critic 四个角色的 `budgetCents` 就是 0（`src/contracts/templates.ts`），走 `/setup` 建出来的工作区里这个框显示「0」、同一页绩效卡却写「上限 ¥600.00」；原来的提交路径是 `Math.round(Number(budgetYuan) * 100)`，清空输入框后 `Number("") === 0`，本意是「删掉上限」，保存下去正好落进最宽的分支——以为收紧了，实际放到最大 |
| 运行成本 | 运行横幅和 Agent 页的最近运行列表：token 未上报印「用量未知」，`cost_source = unknown` 时金额印「费用未知」而不是 ¥0.00；只有 `actual` 或 null（这次根本没调模型）才印金额 | 失败/超时的模型调用可能真的到了供应商那边、只是没报用量（`src/lib/llm.ts` 对 timeout / provider_error / empty_response 都记 unknown），台账已把这份敞口记成 `unknownCents`，Agent 页的「本周模型用量」也把「未知」算进去了——同一页的行里再印 ¥0.00 等于说这次没花钱 |
| 审计运行的用量 | 判卷那次调用会在审计 run 上记下供应商回报的 token 与费用：`mode` 记 `live`、`providerAttemptId` 记本次尝试、`cost_source` 记 `actual`；调用过但没报用量记 `unknown` 且 token 留 null，没判卷（确定性核对）才留 null + `cost_source` 为空。判卷既不预留也不结算，所以它不占周预算上限——连接器页的模型说明照这个写：生成产物与模型选工具用掉的 token 进每周预算台账，判卷那次调用只记在那条审计运行上 | 原来这条 run 无条件写「审计是确定性的、没有供应商、没有用量、没有花费」，而 `judge` 项真的走了一次 temperature 0 的模型调用：结果同一张卡上既印「演示模板」又印「用量未知 · ¥0.00」，判卷的 token 被整条丢掉，事后查账也看不出这次验收花过钱；连接器页那句「用量与费用记在每周预算台账里」同样不成立，会让人以为调低周上限就能挡住判卷的开销 |
| 步骤行的耗时与 token | 任务页每个步骤后面那串「耗时 · token」是这次运行的轨迹，不是账单：没调用模型的步骤印「未调用模型」（规则稿、审计的确定性核对、被拒的工具调用都算），有数的印「约 N tok」，并用 title 说明确定性步骤是估算；真实用量与费用只看上面运行横幅那一行 | 原来这里把 `step.tokensIn + step.tokensOut` 直接拼成「120 tok」，而同一张卡上方印的是「用量未知 · ¥0.00」——同一份运行两份说法。步骤行的常数是刻意留的（`audit.ts` 每个审计步骤 80/40、`apprentice.ts` 200/0 与 120/160、`run.ts` 的 context/plan/submit 220/380/40，连没调模型的 `suggest` 也写了 120/240），`tests/integration/model-usage-accounting.test.ts` 断言的就是「估算只留在步骤行、不污染 run 的实测值」，所以修的是措辞不是数字 |
| 审计链 | 每个用户一条 SHA-256 前向哈希链；哈希按「这一行落进 jsonb 之后的样子」算（对象里值为 undefined 的键会被丢掉，数组里的 undefined 记作 null），所以任何人都能从存下来的行重算并验证 | Review 页可验证 |
| 打卡与记忆 | 一条 check-in 会不会写成记忆，只看它的正文是否为空：学习时长 / 回忆正确率 / 薄弱点 / 备注拼出来的那条（`src/lib/domain/checkin-memory.ts` 的 `checkinMemoryContent`）。同一天重新提交会先删旧记忆再按新正文插一条 | 首页「昨天的偏差」卡上的「已写入记忆」徽章以前是无条件印的，一条什么也没填的打卡也会被说成写进了记忆；现在徽章、打卡表单下方的提示和写入共用同一个函数，空打卡改印「没有内容可写入记忆」，表单也不会再承诺一次不会发生的写入 |
| 记忆 | 证据、scope、冲突、删除、历史；排序 = 词面命中 + 字符 3-gram 相似度 + 时间衰减 + 重要度，可注入外部 rerank；冲突数按整张表数，不看当前这一栏（记忆页那一格写「都在「历史版本」里」，内阁页那一格写「N 条自相矛盾，都在「历史版本」里」——两边都只是指路，不承诺一次不存在的「二选一」裁定） | 没有 embedding / 向量库（本机 Postgres 无 `vector` 扩展）；写入面只有删除（`DELETE /api/memories/:id`，留 `memory.delete` 审计），没有编辑接口，也没有「按领域要求你确认」的闸门——Agent 写的健康类记忆同样直接生效，所以记忆页不承诺这两件事；冲突按栏数会恒为 0：`writeMemoryFact` 记下矛盾时就把被否掉的那条关掉（`validTo = now`、`status = conflicted`），它只出现在历史栏，而内阁页按整张表会同时数到它；冲突通知的链接指向 `?view=history`（`view=current` 打开的是看不到这条记录的页面），正文说明旧的仍在生效、新的只留作历史，要纠正只能删掉生效行；记忆页的列表与右侧两张卡片同处一个两列网格（`lg:grid-cols-[1.7fr_1fr]`），分页条必须留在列表那一列里——网格的直接子元素只能有两个：多出来的那一个会按行流排到右列第一行，两张卡片被挤到列表下方、按左列宽度铺开；页头那格「Stale」数的是 `memories.expires_at` 已经过去的行，而没有任何写入面会写这个字段（`memory/facts.ts` 故意不设 TTL：`policy_config` 里没有保留期这一项，在代码里挑一个常量等于把策略藏起来），所以它恒为 0，hint 改成「还没有记忆设到期时间」，不再让一个恒为 0 的数字读起来像「检查过了，都新鲜」 |
| 学习任务 | 规则生成；知识点掌握度 + SM-2 间隔重复排期；到期优先复习 | 依赖学习目标和 Check-in；难度仍来自配置；只要上一条学习任务还没了结（含"待你判定"），复用的是同一条，不会每打一次卡再发一道——"先查有没有在手任务、再插入"在同一个事务里按用户加了咨询锁，并发打卡/双击"下一题"也只会排出一道 |
| 反思 | 规则候选 → 洞察 → 采纳/回滚；`set_policy` 提案走白名单覆盖表 | 候选仍是规则生成，不调用模型；预算压力那条按 Agent 分桶读（每个桶的额度 = min(该 Agent 预算, 策略默认上限)，工作区能花的是各桶之和），报的是「最紧的那个 Agent 用了 90%」而不是「各 Agent 花费之和 ÷ 单个上限」——后者让每个 Agent 都在额度内的工作区也读成 466%，报出来的「剩余额度」也没有任何 Agent 拿得到 |
| 内阁 | 用户发起；规则生成 5 个立场；批准/有条件批准生成跟进任务，决议写入程序记忆 | 不自动召集；议题挂在「最近在推的那个活跃目标」上（进度也取它，不是一个随机活跃目标），claim 里的「近 7 天 N 个任务」按 SQL 统计，不受展示用的 12 条上限影响；印证异议时给 Agent 加/减信任分是「锁住这一行再读写」，不会把同一时刻审计路径刚提交的增量覆盖掉，审计行里的前后值也就是库里的值；每位成员一次生成一条立场，没有轮次也没有计时（页面上不写「每人 60 秒 / 最多 2 轮」这种没有实现的说法）；异议的证伪门槛（`audit.rejectStreakLimit`）取自你自己的策略值——洞察把这个键调松或调紧之后，会议写下的条件与真正暂停 Agent 的阈值是同一个数；会议规则按真实门槛写——不声称自动召集，也不声称少了 Critic 就「会议无效」（有效性只看参与人数下限），Auditor 不在内阁里；预算异议按预算台账计量（`runs.cost_cents` + 未知用量敞口 `unknown_charged` + 每次工具调用各自的 hold），不把「没报用量」当「没花钱」；决议日期按你的时区写成「2026-10-29 05:30」，来源记 `system`（你点的只是批准，没有写过这条任务）；财务官的「已用」与「剩余」也按 Agent 分桶的额度合计算（种子里 7 个 Agent 合计 7200 分），不再拿单个 Agent 的上限当全工作区总额；Researcher 的「N 条相关记忆」是按议题走 `src/lib/memory/retrieval.ts` 检索出来的（词面命中或 3-gram 相似才留下），不是全库显著性最高的 8 条——后者与议题无关，还会被当作该立场的唯一证据引用；「有条件批准」必须写出条件（校验层只放过 approve 的空 note，服务层再挡一次直接调用），条件会抄进跟进任务的验收标准，不会再记一次没有任何条件的「有条件批准」 |
| 学徒 | 5 条观摩证据 → 确定性考试 → 练习通过 → 常规审计 | 考试是模板产物；练习通过不等于转正 |
| 异议的证伪条件 | 复盘页与判例记忆读同一套措辞（`src/lib/domain/dissent-metric.ts`）：条件写成「7 天内支出 ≥ ¥480.00」「7 天内驳回 ≥ 2 次」，实测值也带单位 | 阈值字段用的是那个键自己的单位（`budget_spend_cents` 是分，其余是次数），原来把 metric / operator / threshold 三个字段原样印出来，¥480 的门槛会印成 48000，记忆里的判例与证据引文也写成 `budget_spend_cents = 52000`；翻译只在这里定义一次，页面与 `council/dissent.ts` 共用，内部键只留在审计行的 `after` 里给机器比对 |
| 决议卡上的异议 | 否决的会议不再说「N 条正式异议已归档」：文案由 `src/lib/presentation/council-view.ts` 的 `resolutionDissentLine` 按 decision 分两句——批准/有条件批准才说「N 条已登记，观察窗口到期后按证伪条件自动判定」，否决说「N 位 Agent 当时持反对意见，没有登记证伪条件」 | `decideCouncil` 只在 `decision !== "reject"` 的分支里插 `dissents` 行：否决没有跟进任务可观察，写进去就永远停在 pending，所以一行都不写；而 `resolution.dissents` 来自 positions，两种决议下都记着「当时谁反对」。原来那句「N 条正式异议已归档」是无条件印的，于是被否决的会议在决议卡上说归档了两条，复盘页的异议栏、内阁页「共 N 条异议」都是 0 |
| 模型 | 默认一次 `generateText`；判卷是 temperature 0 的独立调用；`MODEL_TOOL_SELECTION=on` 时模型每选一次工具都是一次独立调用 | 失败不静默回退，判卷失败降级为"未判定" |
| 外部工具 | `web_search` / `web_fetch` 走真实检索；MCP 服务器按声明调用（`tool-loop.ts runMcpToolLoop`）；`MODEL_TOOL_SELECTION=on` 时改由模型在 `web_search` / `web_fetch` 之间逐步选择（默认关闭，走计划好的单个工具） | 未声明的工具步骤仍是 `not_connected`；两条路径互斥，MCP 调用不经过模型 |
| 检索计费 | `retrieval_calls` 记调用时的单价，只有真正发出去的调用才计 `charged_cents` | "发出去过"用 `statusImpliesContact`（`src/lib/domain/contact.ts`）判定，与周预算结算的 `not_contacted` 同一份：`not_connected` / `unauthorized` / 被预算拒掉的 `skipped` 都记单价、记 0 元；"本周检索 N 次"也只数这些 |

## 七个角色

| 角色 | 默认职责（文案） | 当前实际行为 | 边界 |
|---|---|---|---|
| **Atlas** / chief | 计划、派活、早报、主持内阁 | 内阁决议后跟进任务默认分配给它；早报是模板 | 没有自动拆解/派活 |
| **Iris** / researcher | 找资料、验证来源、给反例 | 工具由 `agents.tools` 的声明顺序 × `agent_grants` 授权决定：取第一个通过注册表与授权的工具，**与角色无关**（`src/lib/domain/tool-plan.ts` 的 `planTools`） | 不按角色分配工具；未声明的工具记 `not_connected`，未授权记 `unauthorized` |
| **Mira** / coach | 出题、陪练、调难度 | 生成下一道学习任务；读取 Check-in | 出题内容是模型/模板，难度规则来自配置 |
| **Vault** / treasurer | 预算、时间、成本 | 内阁里生成预算立场；反思里报告预算压力 | 没有个人账本/日历；预算是 Agent 运行成本 |
| **Justus** / auditor | 独立验收、周审计 | 按验收清单逐条判定；执行者不能自审；`judge` 项交给模型判卷 | 规则判定为主，模型只回答清单里的主观项 |
| **Pip** / apprentice | 影子学习 → 观摩 → 练习考试 | 需要先记录 5 条 mentor 真实运行作为观摩；考试走常规审计；两次失败退休 | 考试是模拟产物；练习通过不改变信任分与等级 |
| **Cass** / critic | 红队、挑战假设 | 只在内阁里生成反对立场 | 规则驱动，不是独立模型 |

## 页面

| 页面 | 路径 | 回答的问题 |
|---|---|---|
| Today | `/` | 今天有什么事、需要我决定什么 |
| Cabinet | `/cabinet` | 有哪些 Agent、状态/预算/授权如何；能力矩阵（声明了哪些工具、哪些真能执行）；页头的「N 个任务」是这位 Agent 经手的全部任务、「成长中」不算已退休的 Agent |
| Agent 详情 | `/cabinet/[id]` | 这个 Agent 的宪章、绩效、运行、技能、记忆；「共 N 条，查看记忆」里的 N 是这张表的真实总数，不是卡片窗格的长度（卡片只放五条，查询也只取八条）；绩效卡里的「Tasks」同样是累计经手的全部任务，与旁边的「N 通过 / M 驳回」同一口径 |
| Task 详情 | `/tasks/[id]` | 验收标准、运行轨迹、产物、审批、审计；运行前策略预演（只读）；待判定时的判定卡与判定后的人判记录 |
| Review | `/review` | 本周指标、复盘、洞察、异议、审计日志 |
| Memory | `/memory` | 记住了什么、证据在哪、是否冲突、能否删除；顶部四块数字（条数、平均置信度、冲突数、已过期）都是整库口径，不是当前这页 25 条 |
| Council | `/council` | 这次高风险决策各方怎么说、怎么定 |
| Review / 审计 | `/review/audit` | 完整审计链，可按动作类型筛选、分页 |
| Settings | `/settings` | 连接器、通知、账号与数据导出/删除（导出为 NDJSON 流） |
| 通知 | `/settings/notifications` | 哪个事件发了邮件、发没发出去、为什么没发 |
| 通知去重 | `outbox.dedupe_key` | 同一件事在收件人自己的本地日里最多一封（按 `users.timezone` 算，不是 UTC 日）；关掉通知后事件照样入队、投递时记 `skipped` |
| 连接器 | `/settings/connectors` | 检索/模型/邮件配好了没，能否连通；模型未配置时按真实后果说话——演示模式下用模板稿照常走完流程（产物标「演示模板」），非演示模式下执行直接失败并落「执行失败」，都不写「停在生成草稿前」 |
| Login | `/login` | 登录 |

## 快速开始

前置：Node 22、pnpm 11、Postgres 18。

```bash
# 1. Postgres
docker compose up -d          # 端口 5433
# DATABASE_URL=postgres://cabinet:cabinet@localhost:5433/cabinet_dev
# 或
brew services start postgresql@18 && createdb cabinet_dev
# DATABASE_URL=postgres://<你的用户名>@localhost:5432/cabinet_dev

# 2. 安装
cp .env.example .env.local
pnpm install
openssl rand -base64 32       # 填入 BETTER_AUTH_SECRET

# 3. 建表 + 演示数据
pnpm db:migrate
ALLOW_DESTRUCTIVE_SEED=true pnpm db:seed

# 或本地迭代：ALLOW_DESTRUCTIVE_SEED=true pnpm db:setup

# 4. 启动
pnpm dev
```

`db:seed` 会清空所有表，只用于本地演示。

### 升级一个已存在的工作区

`policy_config` 里新增的设置项不会单独出一个 migration，而 `getPolicyConfig()` 对缺失的键是 fail-closed：少一个键，Today / Review / Cabinet 全部 500。升级已有数据库（尤其是用 `db:push` 建出来的）后跑一次：

```bash
pnpm db:sync-policy          # 补齐缺失的分组与嵌套设置项
pnpm db:sync-policy --check   # 只检查不改，有 drift 时退出码 1（适合放进部署前置检查）
```

命令只做加法：已存在的值（包括你手改过的）永远保留，因此可以重复执行、也可以对生产执行。

### 模型与演示模式

二选一：

```bash
# A. 不调用模型：使用确定性模板
DEMO_MODE=true
DEMO_LOGIN_ENABLED=true

# B. 调用真实模型
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
DEMO_MODE=false
```

- `DEMO_MODE=true` 时，未配置 Key 或调用失败会退回模板。
- `DEMO_MODE=false` 时，未配置 Key 或调用失败会让任务失败，不会生成模板产物。
- 可选 `OPENAI_JUDGE_MODEL`：只给判卷用（缺省回落到 `OPENAI_MODEL`）。判卷要的是稳定，所以温度固定 0，和写产物的那次调用互不影响。
- 可选 `MODEL_TOOL_SELECTION=on`：让模型自己决定调 `web_search` 还是 `web_fetch`（默认关闭，走计划阶段选好的单个工具）。开启后每次工具调用都是一次独立的计费请求，用量按实际 token 记账。
- `AUTH_REQUIRED=false` 只用于本地；生产环境会自动要求登录（`NODE_ENV=production`），并应设置 `DEMO_MODE=false`、关闭演示登录和 reset。
- 只有 `DEMO_RESET_ENABLED=true` 且 `DEMO_MODE=true`、不在生产时才出现侧边栏的「重置演示数据」：按钮显隐与 `/api/demo/reset` 读同一个 `demoResetAllowed()`，默认配置下不会摆一个点下去必然 404 的按钮。
- 演示账号：`demo@cabinet.local` / `cabinet-demo`。

## 演示路径

1. **Today**：生成早报，查看目标、任务和待审批。
2. 打开已提交的「设计检索评估练习」→ 运行验收 → 因缺少评分标准被驳回。
3. 执行任务（`DEMO_MODE=true` 时生成模板产物）→ 再次验收 → 通过。
4. **Review**：运行反思 → 采纳或回滚一条洞察。
5. **Council**：打开已有会议，查看 5 个规则立场 → 做出决议。
6. **Cabinet**：暂停/恢复 Agent、修改预算或宪章、调整自主等级（需满足阈值）。
7. **学徒考试**：需要先在学徒详情页记录 5 条 mentor 观摩（seed 只有 1 次可记录），再点“参加考试”。

## 架构

```
RSC 页面 / 客户端组件
  → @/contracts + @/lib/api
  → HTTP（同源；可配 API_BASE_URL）
app/api/**（route handler）
  → server/readmodels · server/services（queries / commands）
  → domain（纯函数：policy / state / acceptance）
  → Postgres（Drizzle）
```

- route handler 当前 <!-- doc-facts:routes -->51<!-- /doc-facts:routes --> 个（`find src/app -name route.ts | wc -l`；由 `pnpm doc:facts` 生成，不要手改）。
- 页面和组件不能 import `server/`、`lib/db`；ESLint + `tests/unit/boundary.test.ts` 强制。
- `src/lib` 也不能 import `@/server/*`，**没有豁免**。曾经的唯一例外 `src/lib/engine.ts`（@deprecated 垫片）已删除，调用方直接指向 `@/server/services/engine`；留一个具名豁免等于让「再加一条」成为破坏边界最省事的方式。
- `server/services/engine.ts` 只是 re-export barrel，业务在 `queries/` 和 `commands/`。
- 默认在请求内同步执行；`RUN_EXECUTION=worker` 时改为 `run_jobs` 队列 + `scripts/run-worker.ts` 消费。异步环节还有邮件投递（`outbox` + `pnpm notify:deliver`）和 `pnpm tick` 维护循环；三者都靠部署层调度，不是 web 进程里的定时器。`pnpm tick` 现在是九步（`tickSteps`），其中 `releaseStaleHolds` 管的是每次工具调用各自那笔 3 分预扣：进程崩在预扣与结算之间时，超过 15 分钟仍停在 `reserved` 的行按 `not_contacted` 退回去，否则那笔钱会一直占着且账上无处解释。`docs/run-durability.md` 那张步骤表由 `tests/unit/tick-steps.test.ts` 按 `tickSteps` 的顺序逐项对账（写「八步」、漏掉一步都会红）。
- 没有使用 LangGraph / CrewAI；状态机和审计是应用代码。
- 连接器与证据的规则见 `docs/evidence-and-connectors.md`，通知见 `docs/notifications.md`。
- 一次运行可以导出成可离线校验的 manifest（Merkle + 审计链头），见 `docs/manifest.md`；manifest 里每个列表都按「时间 + id」排序，同一份 run 两次导出的字节相同（只按时间排时，同一事务写入的行顺序由物理行序决定）；`promptVersion` 取自 run 行（生成时写死），不随导出的构建变——否则同一条没变过的 run 换个版本重导就会声称是另一个模板产的。任务页对这两份出口的说法与 `docs/manifest.md` 的「代价要说清楚」一节同一口径：只有步骤与产物是哈希，验收逐条判定带的是清单条目原文、契约整份是文字（都不含提示词原文，提示词只以哈希出现）；离线重算的是 digest 与 merkle 根之间的对应关系，digest 保护的是「文件没被随手改动」，改内容的人把 digest 一起重算就验不出来——要证明「这份文件出自本系统」得让审计头对上链。验收标准可导出成可 diff 的契约，见 `docs/acceptance-contract.md`；外部工具调用的治理见 `docs/mcp.md`。

技术栈：Next.js 16、React 19、TypeScript、Tailwind 4、Postgres + Drizzle、better-auth、Vercel AI SDK（可选）。

## 数据模型

当前 <!-- doc-facts:tables -->40<!-- /doc-facts:tables --> 张表（`grep -ro 'pgTable(' src/lib/db/schema | wc -l`；由 `pnpm doc:facts` 生成）。

- 账号：`users` `sessions` `accounts` `verifications`
- 工作区：`profiles` `agents` `agent_templates` `agent_grants` `goals` `policy_config`
- 执行：`tasks` `runs` `steps` `artifacts` `approvals` `evidence` `retrieval_calls`
- 记忆：`memories` `insights` `skills` `apprentice_observations` `apprentice_exam_snapshots`
- 治理：`councils` `council_positions` `dissents` `audit_events` `reviews` `checkins`
- 运维：`idempotency_keys` `user_actions` `rate_limits` `outbox` `run_jobs`
- 记账：`agent_budget_periods` `agent_budget_reservations`

状态机：

- Task：`planned → assigned → running → submitted → auditing → accepted / rejected / needs_review → done`（`needs_review` 只能由用户判定带走；外部动作先走 `awaiting_approval`）
- Run：`running → succeeded / failed`（状态机也定义了 `queued`，当前任务运行直接从 `running` 开始）
- Goal：`active → paused / completed / archived`；`paused / completed / archived → active`（重新打开）
- Agent：`probation → active → paused → retired`
- Apprentice：`shadowing → drafting → examining → active`；失败一次回 `drafting`，失败两次 `retired`
- Insight：`proposed → applied / rejected`；`applied → rolled_back`
- Approval：`pending → approved / rejected / expired`
- Council：`open → decided`
- Dissent：`pending → vindicated / invalidated`

## 验证

本地门禁和 CI 是同一组步骤，跑一份即可：

```bash
pnpm verify            # 等价于 bash scripts/verify.sh
```

它依次跑 `tsx scripts/doc-facts.ts --check`、`drizzle-kit migrate`、`tsc --noEmit`、`eslint`、`vitest run --maxWorkers=1 --no-file-parallelism`、`next build`。第一步不碰数据库、只读 README，比对生成块与扫描结果，不一致就打印 diff 并退出码 1——数字过期是最便宜的失败，所以排在创建临时库之前。migrate 这一步在**临时新建的库**上跑，因为长期存在的本地库通常是 `pnpm db:push` 建的、`drizzle.__drizzle_migrations` 是空的，直接 migrate 会在 0000 上撞已存在的对象。

测试文件与用例数由扫描生成，不手写：<!-- doc-facts:testFiles -->173<!-- /doc-facts:testFiles --> 个 `tests/**/*.test.ts`、<!-- doc-facts:testCases -->1484<!-- /doc-facts:testCases --> 条用例声明（`test(` / `it(` 调用点；`it.each` 在运行时按数据集展开成多行，所以这个静态计数和 vitest 报的 passed 不是同一个口径）。改完代码跑 `pnpm doc:facts` 重写这些数字，`pnpm verify` 会替你检查有没有漏。

2026-10-27 在当前分支实测：`vitest run` 报 1335 passed / 0 failed，typecheck / lint / build 均通过（`bash scripts/verify.sh` exit 0）。没有调用真实模型，也没有做浏览器 E2E。通过/失败计数不写在这里——它每次运行都不同，写下来就是下一条会过期的数字。

### GitHub Actions 现在需要手动触发

`.github/workflows/ci.yml` 配了 `push`（`main`、`fix/**`、`feat/**`、`refactor/**`）和 `pull_request`，但**这个仓库的 push 事件从未产生过 workflow run**：从建 workflow 到 2026-10-24 的 `actions/runs` 累计 0 条；推一个空提交（`f818051`）和新建一个 `feat/ci-probe-*` 分支分别推送后仍是 0 条；同一份 workflow 用 `gh workflow run` 手动触发却能跑完 8 个步骤。仓库不是 fork、未归档、未禁用，`actions/permissions` 是 enabled/all，所以问题在触发侧而不是配置侧。

推完要显式触发，否则等于没有门禁：

```bash
gh workflow run ci.yml --ref "$(git branch --show-current)"
gh run watch
```

2026-10-24 手动触发的 run 40052577312 全绿（install / migrate / typecheck / lint / test / build）。

## 已知边界

- **只有检索是真的**：`web_search` 接了 Brave（Tavily 作为可重试的兜底），命中的来源落库为 `evidence` 行，产物必须用 `[cite:evd_x]` 引用它们。日历、预订、支付仍然没有连接器，这些工具步骤会记 `not_connected` 或 `unauthorized`。
- **不是自治多 Agent**：没有 Agent 间消息、协商或自动委派；内阁由用户发起，立场由规则生成。
- **用户判定带出状态、记忆和复习排期，但不动 Agent 绩效**：`needs_review` 由用户判成 accepted/rejected，会写任务状态、审计行、一条任务记忆，并推进该知识点的复习排期（学习任务）；不会补算 Agent 绩效（信任分只认 Auditor 给出的结论），但判成 accepted 时会当场重算目标进度：进度是按任务状态现算的，这一行已经是 accepted，不重算就等于让页面显示一个当时并不成立的数字，等下一次打卡触发重算时再自己跳上去。判定记录会显示在任务页验收卡片上方（`audit.override` 单独取一条，不受审计时间线 10 条窗口影响）。
- 学徒页的两个训练入口（记录观摩、参加考试）只在还能训练时出现：`src/lib/presentation/cabinet-view.ts` 的 `apprenticeTrainingOpen` 把 `active`（已转正）、`practice_passed`（只剩转正）、`retired`（已退休）都排除掉。原来页面手写「不等于 active 且不等于 practice_passed」，正好漏了 retired——退休学徒页上仍摆着两个按钮，点哪个都只会拿到一句报错（`recordApprenticeObservation` 抛「已退休的学徒不能再记录观摩。」、`runApprenticeExam` 抛「Apprentice is retired and cannot take the exam.」），下面的「记录满 N 条才能参加考试」也已经是空话。退休时卡片改印一句已退休说明。
- **学徒考试是模拟**：考试产物由确定性模板生成；5 条验收项必须全部通过；考试前需要 5 条显式记录的观摩证据（只有 mentor 的真实模型运行、且任务已验收才算）。练习通过只把阶段推进到 `practice_passed`，不授予生产技能、不加信任分、不提等级。
- **练习通过之后的转正门槛，默认工作区里满足不了**：`decideGraduation` 要练习之后的真实审计证据（信任分、成功任务、live 运行 + 模型生成产物的有效样本与通过率），可 `decideRun` 在 `lifecycleStage !== "active"` 处就先拒（`src/lib/domain/policy.ts:327-329`），学徒模板的授权又只有 `task:read`（`src/contracts/templates.ts:134`）——派单、批准、常驻授权都不会让学徒跑出一次运行，样本自然停在 0。所以学徒卡片在 `practice_passed` 时会如实写清这段缺口（`GRADUATION_EVIDENCE_GAP`，`src/lib/presentation/cabinet-view.ts`），`graduateApprentice` 的注释也记下同一件事；开一条「受监督执行」通道是产品决定，这一版只保证页面不承诺一件做不到的事。
- **技能卡用它自己的词**：学徒详情页那张「技能与考试」卡原来借用 Agent 的 `statusLabel`——技能转正后 `skills.status` 也是 `active`，于是被印成「在岗」；副行还把内部键 `label`（`draft` / `practice` / `v1`）原样印出来，转正后读作「v1 · v1」。现在徽章走 `skillStatusLabel`（技能草案 / 考试中 / 已转正），考试行走 `examStatusLabel`（还没考过 / 练习通过 / 未通过），`label` 不再上页面（卡上已经有徽章和版本号）；两个词表都在 `src/lib/presentation/cabinet-view.ts`，判据是 `skills.status` 只有 `draft` / `active` 两个真实取值（`exam` 没有写入面）、`skills.eval.status` 只有 `apprentice.ts` 写的那三个。
- **早报、周复盘、反思候选是规则/模板**：不调用模型。反思能提出真实的策略覆盖（`set_policy`，16 个白名单键，可回滚），但"要不要提出"本身是规则判断，不是模型分析。
- **记忆检索没有 embedding**：排序是词面命中 + 字符 3-gram 相似度 + 时间衰减 + 重要度；本机 Postgres 没有 `vector` 扩展，所以没有向量检索。`retrieveMemories` 留了 `rerank` 钩子，接外部重排模型不需要改调用方。
- **掌握度视图是只读摘要**：`/api/learning/mastery` + Review 页的掌握度卡片（按掌握度从低到高列前 6 个、到期数单独显示；页脚「共 N 个主题」的 N 是整表数，不是最多 50 条的列表长度）。没有手动编辑掌握度或重置复习计划的入口。
- **判卷依赖模型**：`judge` 项没有配置 `OPENAI_API_KEY` 时永远是"未判定"（不会自动通过）；真实模型路径没有网络级测试，测试里注入的是假判卷函数。
- **管理时长没有埋点**：`user_actions` 只有 seed 写入；真实工作区会显示估算或空值。
- **成本是估算**：按供应商返回的 token 数和配置单价计算，不是供应商账单；没有返回 usage 的运行记为“用量未知”并保留全额预留。预算是 Agent 的每周模型用量，不是个人财务。
- **台账是唯一账目**：周预算由 `agent_budget_periods` / `agent_budget_reservations` 记账，`runs.cost_cents` 只是逐次运行的遥测，`agents.spent_cents` / `agents.budget_period_start` 已冻结，不再读写。
- **同步执行是默认值**：`RUN_EXECUTION=worker` 才把请求交给 `run_jobs` 队列（`scripts/run-worker.ts` 消费；`FOR UPDATE SKIP LOCKED` 领取、10 分钟租约、最多领取 5 次，见 `src/server/services/commands/tasks/jobs.ts`）。**没有通用重试调度**：重新领取只发生在“租约过期”这一种情况；也没有流式输出，响应是完整 JSON。
- **时区写进去就改不了**：`users.timezone` 只在 setup 时写入，之后没有界面能改，而每个页面的时间都用它格式化——所以 `setupSchema` 会拒掉 `Intl.DateTimeFormat` 不认的时区（校验器是 `src/lib/domain/time.ts` 的 `isValidTimeZone`），否则一次手滑就能把工作区变成每页都报错的死局。
- **Agent Card 未签名**：只读 JSON，不是 A2A 实现。

## License

Private MVP。未选择开源许可证。
