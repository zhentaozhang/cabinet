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
