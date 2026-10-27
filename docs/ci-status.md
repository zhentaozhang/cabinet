# CI 触发状态诊断（2026-10-25）

结论先行：**这个仓库的 push 事件至今没有产生过任何 workflow run**，本文件记录的是排查到哪一步、哪些假设被证伪、以及在此前提下门禁怎么用。不做无证据的归因。

## 已采集的证据

| # | 命令 | 输出 | 证明什么 |
|---|---|---|---|
| 1 | `gh api repos/zhentaozhang/cabinet/actions/permissions` | `{"enabled":true,"allowed_actions":"all","sha_pinning_required":false}` | Actions 在仓库层是开启的，不是"功能被关掉" |
| 2 | `gh api repos/zhentaozhang/cabinet/actions/workflows` | `CI  active  .github/workflows/ci.yml` | workflow 处于 active 状态，不是被禁用 |
| 3 | `gh api 'repos/zhentaozhang/cabinet/actions/runs?per_page=5'` | `total_count = 5`，5 条全是 `workflow_dispatch` | 历史累计只有手动触发；**push / pull_request 事件一条都没有** |
| 4 | `gh api repos/zhentaozhang/cabinet` | `{fork:false, archived:false, disabled:false, private:false}` | 不是 fork、未归档、未禁用、**公开仓库**（Actions 分钟数不受限） |
| 5 | `gh api 'repos/zhentaozhang/cabinet/contents/.github/workflows/ci.yml?ref=main'` | sha `e6aecc2a82dddc…`，1742 字节 | workflow 文件确实在默认分支 main 上，不是"只在 feature 分支所以不跑" |
| 6 | `gh api 'repos/zhentaozhang/cabinet/commits?sha=main&per_page=3'` | 最新提交 `743fe85`，2026-10-24T10:24Z | 在最近一次手动 run（02:09Z）之后**还有真实 push 落到 main**，仍然没有 run |

## 被证伪的假设

- **"workflow 分支过滤写错了"** —— 证据 4/5：文件在 main 上，`on.push.branches` 含 `main`，而 main 在 10:24Z 有过提交却没有 run。如果是过滤问题，至少 `main` 命中。
- **"Actions 被禁用 / 额度用尽"** —— 证据 1/4：enabled + public。
- **"workflow 文件不在默认分支"** —— 证据 5 直接反驳。
- **"只是没人推过代码"** —— 证据 6 反驳。

## 尚未排除的假设（本轮无法判定）

1. 账号级 Actions 准入限制（例如 GitHub 对新账号/未验证手机号的静默限制）。`actions/permissions` 仍会返回 enabled，所以这个 API 无法区分。
2. push 经由某个不触发 workflow 的凭据完成（部署密钥 / GitHub App token 的 push 不产生 run）。当前 `origin` 是 HTTPS + gh keyring，理论上是用户 OAuth token，**但这只是推断，没有证据**。
3. GitHub 侧的事件投递故障（无 API 可查）。

按仓库"没有证据就写未判定"的规则，这里**不定因**。

## 在此前提下的门禁使用方式

1. 本地门禁是唯一可靠路径，且与 CI 的步骤完全一致：

   ```bash
   pnpm verify            # = bash scripts/verify.sh
   ```

   它跑 `drizzle-kit migrate`（在临时新建库上）、`tsc --noEmit`、`eslint`、`vitest run`、`next build`。
2. 需要云端结果时手动触发，并在触发后确认 run 真的出现：

   ```bash
   gh workflow run ci.yml --ref "$(git branch --show-current)"
   gh run list --limit 1        # 必须看到刚才的 run，不能只看命令是否 exit 0
   ```

3. **下一个真实 push 就是本诊断的下一步实验**：push 之后跑 `gh api 'repos/zhentaozhang/cabinet/actions/runs?per_page=3' --jq '.workflow_runs[]|[.event,.head_branch]'`，若仍无 `push` 行，则假设 1/2 至少有一个成立，需要人工在网页端核对账号的 Actions 准入状态。

## 为什么不在本轮"修"它

可以在仓库侧改的东西只有 workflow 文件本身，而证据 4/5/6 已经排除了文件层面的三种失败模式。在没有证据的情况下改 CI 配置属于"用改动掩盖未知"，会让真正的根因更难定位。因此本轮只做诊断与记录，不改 workflow。

## 2026-10-27 push 实验

目的：上面那份诊断留下的下一步实验——真实 push 一次，看 push 事件到底会不会产生 run；若仍不产生，再用 `workflow_dispatch` 做对照，把「push 不触发」和「CI 整体不跑」这两种失败区分开。

### 推送的提交范围

| 项 | 值 |
|---|---|
| 旧 `origin/main` | `743fe85879650910cdb54b329a59c49419bc697c` |
| 新 `main`（= 现在的 `origin/main`） | `1565102a336e689f1ce0742f1f1994f234a6bcbc` |
| 提交数 | 19（`git rev-list --count 743fe85..1565102` = 19） |
| 首 | `3f739f6 docs: calibrate README against measured facts, record CI trigger diagnosis` |
| 末 | `1565102 feat: close the learning loop and make reflection change real policy` |
| push 命令 | `git push origin main`（无 `--force`） |
| push 时刻（UTC） | 2026-10-27T14:55:14Z → 2026-10-27T14:55:17Z，exit 0 |
| push 输出 | `   743fe85..1565102  main -> main` |

### 观测到的 run 列表（原文关键字段）

推送后按 30 秒间隔轮询 8 次（14:56:08Z 至 14:59:48Z），再于 15:00:02Z 用 API 复核，**总计约 4 分 45 秒内没有出现任何新 run**：

```
$ gh api 'repos/zhentaozhang/cabinet/actions/runs?per_page=10' --jq '.total_count'
5
```

即：push 之前 `total_count` 是 5，push 之后仍是 5，且 5 条全部是 2026-10-24 的 `workflow_dispatch`：

```
40052994576  workflow_dispatch  feat/council-closed-loop  63750b4…  completed  success  2026-10-24T02:09:33Z
40052577312  workflow_dispatch  feat/council-closed-loop  b5f855d…  completed  success  2026-10-24T02:03:44Z
40052122193  workflow_dispatch  feat/council-closed-loop  d2443ce…  completed  failure  2026-10-24T01:57:39Z
40052005637  workflow_dispatch  feat/council-closed-loop  946b16b…  completed  failure  2026-10-24T01:56:01Z
40051809476  workflow_dispatch  feat/council-closed-loop  1dff903…  completed  failure  2026-10-24T01:53:21Z
```

### 对照组：手动 dispatch

15:00:07Z 执行 `gh workflow run ci.yml --ref main`（exit 0，输出 run URL `https://github.com/zhentaozhang/cabinet/actions/runs/40526610567`），20 秒后 `gh run list --limit 3` 立刻返回新 run：

```
40526610567  workflow_dispatch  main  1565102a336e689f1ce0742f1f1994f234a6bcbc  in_progress  2026-10-27T15:00:07Z
```

注意它的 `headSha` 正是本次推送上去的 `1565102`、`headBranch` 是 `main`——也就是说同一份代码、同一个分支，dispatch 能跑，push 不跑。

该 run 于 15:04:09Z 结束，**结论 `failure`**，逐 step 状态（`gh run view 40526610567 --json jobs`）：

| step | 结论 |
|---|---|
| Set up job / Initialize containers / checkout / pnpm setup / setup-node | success |
| `pnpm install --frozen-lockfile` | success |
| `pnpm db:migrate` | success |
| `pnpm typecheck` | success（15:00:38Z→15:00:53Z） |
| `pnpm lint` | success（15:00:53Z→15:01:06Z） |
| `pnpm test` | **failure**（15:01:06Z→15:04:06Z） |
| `pnpm build` | skipped |

测试步骤的原文数字（`gh run view 40526610567 --log`）：

```
 Failed Tests 8
 FAIL tests/integration/outbox.test.ts > delivery > sends a due row and marks it sent
 FAIL tests/integration/outbox.test.ts > delivery > defers during quiet hours instead of dropping the message
 FAIL tests/integration/outbox.test.ts > delivery > keeps a missing SMTP configuration in the queue instead of dropping it
 FAIL tests/integration/outbox.test.ts > delivery > reclaims a row whose runner died while sending
 FAIL tests/integration/outbox.test.ts > delivery > refuses to write back a result it no longer owns
 FAIL tests/integration/outbox.test.ts > delivery > clears the claim token once it writes the outcome
 FAIL tests/integration/outbox.test.ts > delivery > retries a real failure with backoff, then gives up
 FAIL tests/integration/outbox.test.ts > delivery > does not send the same row twice when two runners race
 Test Files  1 failed | 132 passed (133)
      Tests  8 failed | 1247 passed (1255)
```

断言原文是 `AssertionError: expected +0 to be 1 // Object.is equality`（7 处）与 `expected 'pending' to be 'sent'`（1 处）。

**这不是 CI 环境独有的失败**：在本地用 `DATABASE_URL_TEST=postgres://localhost:5432/cabinet_test TZ=UTC ./node_modules/.bin/vitest run tests/integration/outbox.test.ts`（PostgreSQL 18.3 / Homebrew）复跑同样 8 条失败，`Tests 8 failed | 8 passed (16)`，失败断言行号 `outbox.test.ts:132,181,201,229,256,277,317,355`。因此 main@`1565102` 在本地和云端都是红的，红的是 outbox 投递这一套（claim 之后 `0` 次发送、状态停在 `pending`），与本次 push 无关。

### 判定

**push 不触发，但 dispatch 可用。**

- 反证「CI 整体不可用」：40526610567 在 20 秒内被创建，且完整跑完了 `install → migrate → typecheck → lint → test` 五步（15:00:12Z 起，15:04:09Z 结束），workflow 文件、Actions 开关、runner、Postgres service 容器都是通的。它最终 `failure` 是**测试真的红**（见上表 outbox 8 条），不是基础设施不跑。
- 反证「只是没人推过代码 / 分支过滤写错」：本次是真实 `git push` 到 `main`（`on.push.branches` 的第一个元素就是 `main`），且 push 后 `total_count` 未变。
- 因此上一节列的「尚未排除的假设」里，第 1 条（账号级 Actions 准入限制）与第 2 条（push 经由不产生事件的凭据完成）仍然成立，且现在**至少有一条为真**。本轮仍未定因：`gh auth status` 报 keyring token invalid（`The token in keyring is invalid`），无法从这个凭据本身判断 push 是用哪种凭据完成的。

### 下一步建议

1. 人工在网页端核对账号 Actions 准入状态（Settings → Actions → 是否有账号级限制提示），这是第 1 条假设唯一的验证入口。
2. 若要验证第 2 条：在 GitHub 网页端对 main 做一次空提交（Web UI commit），它必然产生 push 事件且由网页凭据发起；若网页提交能触发 run、本地 push 不能，则假设 2 成立（本地 push 凭据不产生事件）。
3. 在结论变化之前，云端门禁继续按上一节的方式手动 dispatch，并在触发后确认 run 真的出现（不要只看 exit 0）。
4. 云端门禁要先修 outbox 投递那 8 条失败（`tests/integration/outbox.test.ts` delivery 分组，本地可复现），否则 dispatch 出来的 run 永远 `failure`，"CI 是否是绿的"这个问题会被这个已知红灯掩盖。
5. 本仓库的 `.gitignore` 已补上 `.archify/` 与 `.workbuddy-ai/`（299 个文件 / 7.3M 的工具产物），避免下次 `git add -A` 把它们卷进来。

