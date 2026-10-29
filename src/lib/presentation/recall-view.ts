/**
 * 回忆正确率那一格的写法。
 *
 * 依据：`recallAvg` 是 `avg(checkins.recall_score)`（src/server/services/queries/metrics.ts:215），
 * 而 `checkins.recallScore` 只有一个写入面——打卡表单里那个选填的「回忆正确率 %」
 * （src/components/actions/task-actions.tsx:885，placeholder 是「可留空」）。它不是做完复测
 * 被判出来的分：复测通过率是另外一格，结论来自 `learning_retest` 任务的审计行
 * （src/server/services/queries/metrics.ts 的审计聚合，还没判的不进分母）。
 *
 * 原来两处文案都把它说成复测来的：「本周没有复测样本，不用 0 代替。」和
 * 「0-100%，来自本周检索式复测。」——这一周一个复测都没排、但打卡里自评过回忆分，
 * 这一格照样有数字；反过来排了复测却没在打卡里自评，它一直是「—」。数字没错，说的是
 * 来源错了，而同一屏上「复测通过率」是另一个数，读者会把两者当成同一件事。
 */
export function recallAverageHint(recallAvg: number | null): string {
  if (recallAvg === null || !Number.isFinite(recallAvg)) {
    return "本周打卡里没有填过回忆正确率，不用 0 代替。";
  }
  return "0-100%，你在本周 check-in 里自评的回忆正确率平均分；复测通过率是另一格。";
}

/** 今日页六格里的短提示：同样不能写成「Retest 平均分」。 */
export const RECALL_CELL_HINT = "本周 check-in 自评";
