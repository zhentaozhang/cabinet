/**
 * 记忆检索的纯工具：字符 3-gram 相似度、加权合成。
 *
 * 这里刻意不做任何 IO（不查库、不读环境变量、不读时钟）：检索排序的单元测试
 * 要能精确复现"为什么这条记忆排在前面"，一旦掺进 IO，测试失败就分不清是排序
 * 逻辑错了还是环境不对。模型重排是可选的异步钩子，放在 retrieval.ts 的调用方，
 * 不进入本模块。
 */

/** 参与打分的一路信号。 */
export type ScorePart = {
  /** 已归一化到 0–1 的信号强度。 */
  value: number;
  /** 该信号的权重，由调用方的 WEIGHTS 决定。 */
  weight: number;
};

/** 3-gram 最少需要的字符数：再短就只能退化成包含判断。 */
export const TRIGRAM_LENGTH = 3;

/**
 * 只保留字母、数字与汉字并转小写。
 *
 * 标点、空白、全角冒号都是"排版"，不是"内容"：不归一化的话
 * "晚上 20:00 运动" 与 "晚上20:00运动" 会被当成两条不同的记忆，
 * 空格还会把 3-gram 切碎，让本该相似的句子相似度掉一半。
 */
export function normalizeForSimilarity(text: string): string {
  let normalized = "";
  for (const char of text.toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(char)) normalized += char;
  }
  return normalized;
}

/**
 * 3-gram 计数表。按码点切分而不是 UTF-16 下标：表情和生僻字是代理对，
 * 按码点切才不会把一个字劈成两半，造出根本不存在的 gram。
 */
function trigramCounts(text: string): Map<string, number> {
  const chars = Array.from(text);
  const counts = new Map<string, number>();
  for (let start = 0; start + TRIGRAM_LENGTH <= chars.length; start += 1) {
    const gram =
      chars[start] + chars[start + 1] + chars[start + 2];
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/**
 * 字符 3-gram 的 Dice 系数：2|A∩B| / (|A|+|B|)，取值 0–1。
 *
 * 用 Dice 而不是 Jaccard，是因为它对"长度差异"更宽容——记忆里往往带上下文、
 * 查询只有几个词，Jaccard 会把所有长记忆一起罚到接近 0，长短记忆之间就比不出
 * 谁更相关了。重复出现的 gram 两边都计次（"的的的" 不该和 "的" 等价）。
 *
 * 长度不足 3 个字符时拼不出 gram，退化为"是否互相包含"：两个字的中文词
 * （"运动"）在真实查询里很常见，判成包含关系比一律判 0 更有用。
 */
export function trigramSimilarity(a: string, b: string): number {
  const left = normalizeForSimilarity(a);
  const right = normalizeForSimilarity(b);
  // 任一侧没有可比较的内容时不给分：空查询若得高分，会把整库记忆都算成相关。
  if (left.length === 0 || right.length === 0) return 0;

  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  if (
    leftChars.length < TRIGRAM_LENGTH ||
    rightChars.length < TRIGRAM_LENGTH
  ) {
    const [shorter, longer] =
      leftChars.length <= rightChars.length ? [left, right] : [right, left];
    return longer.includes(shorter) ? 1 : 0;
  }

  const leftGrams = trigramCounts(left);
  const rightGrams = trigramCounts(right);
  let overlap = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (const count of leftGrams.values()) leftTotal += count;
  for (const count of rightGrams.values()) rightTotal += count;
  for (const [gram, count] of leftGrams) {
    const other = rightGrams.get(gram);
    if (other !== undefined) overlap += Math.min(count, other);
  }

  return (2 * overlap) / (leftTotal + rightTotal);
}

/**
 * 加权求和。
 *
 * 非有限值（NaN/Infinity）按 0 计：一个坏信号（比如内容为空导致下游算出 NaN）
 * 会让总分变成 NaN，而 NaN 参与比较时恒为 false，排序会静默退化成"输入顺序"——
 * 这种失败在应用里表现为"最近检索不出东西"，几乎无法定位。宁可少一路信号。
 */
export function combineScores(parts: readonly ScorePart[]): number {
  let total = 0;
  for (const part of parts) {
    if (!Number.isFinite(part.value) || !Number.isFinite(part.weight)) continue;
    total += part.value * part.weight;
  }
  return total;
}

/** 把任意数值夹到 0–1，非有限值归零。用于把外部数据（salience）变成合法信号。 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
