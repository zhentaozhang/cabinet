/**
 * 一条 check-in 会写成的那条记忆的正文。
 *
 * 写入发生在 `saveCheckin`（src/server/services/commands/checkins.ts）：重新提交会先按
 * `sourceEventId` 删掉旧记忆再插新的，而「插不插」看的正是这个正文是否为空——一条既没
 * 学习时长、也没填回忆分 / 薄弱点 / 备注的打卡不产生记忆行。
 *
 * 首页「昨天的偏差」卡上的「已写入记忆」徽章以前是无条件印的，于是这种空打卡也会被
 * 说成写进了记忆。徽章与写入走同一个函数，才不会各说一套。
 */
export type CheckinMemorySource = {
  studyMinutes?: number | null;
  recallScore?: number | null;
  errorTags?: readonly string[] | null;
  note?: string | null;
};

export function checkinMemoryContent(input: CheckinMemorySource): string {
  const studyMinutes = Math.max(0, Math.round(input.studyMinutes ?? 0));
  const recallScore = input.recallScore ?? null;
  const errorTags = [...new Set(input.errorTags ?? [])];
  return [
    studyMinutes > 0 ? `学习 ${studyMinutes} 分钟` : null,
    recallScore !== null
      ? `回忆正确率 ${Math.round(recallScore * 100)}%`
      : null,
    errorTags.length > 0 ? `薄弱点：${errorTags.join("、")}` : null,
    (input.note ?? "").trim() || null,
  ]
    .filter(Boolean)
    .join("；");
}
