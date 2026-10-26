import { describe, expect, it } from "vitest";
import {
  RECENCY_DECAY,
  RECENCY_HALF_LIFE_HOURS,
  WEIGHTS,
  scoreMemories,
} from "@/lib/memory/retrieval";
import { combineScores, trigramSimilarity } from "@/lib/memory/rerank";

const now = new Date("2026-10-22T12:00:00Z");

type Fixture = {
  id: string;
  content: string;
  salience: number;
  createdAt: Date;
  lastConfirmedAt: Date | null;
  expiresAt: Date | null;
};

function memory(input: {
  id: string;
  content: string;
  salience?: number;
  ageHours?: number;
  expiresAt?: Date | null;
}): Fixture {
  const anchor = new Date(now.getTime() - (input.ageHours ?? 0) * 3_600_000);
  return {
    id: input.id,
    content: input.content,
    salience: input.salience ?? 0.5,
    createdAt: anchor,
    lastConfirmedAt: anchor,
    expiresAt: input.expiresAt ?? null,
  };
}

describe("trigramSimilarity", () => {
  it("相同中文短句得 1", () => {
    expect(trigramSimilarity("晚上精力不足", "晚上精力不足")).toBe(1);
  });

  it("共享开头但结尾不同时按 Dice 系数打折", () => {
    // "晚上精力不足" 4 个 3-gram，"晚上精力明显不足" 6 个，交集 2 个
    // → 2*2/(4+6) = 0.4
    expect(trigramSimilarity("晚上精力不足", "晚上精力明显不足")).toBeCloseTo(
      0.4,
      10,
    );
  });

  it("完全无关的中文句子得 0", () => {
    expect(trigramSimilarity("晚上精力不足", "周末读小说")).toBe(0);
  });

  it("字符顺序不同不算相似（3-gram 是有序的）", () => {
    expect(trigramSimilarity("晚上精力", "精力晚上")).toBe(0);
  });

  it("大小写、空白与标点不影响相似度", () => {
    expect(trigramSimilarity("晚上 20:00 运动", "晚上20:00运动")).toBe(1);
    expect(trigramSimilarity("Deploy Pipeline", "deploy pipeline")).toBe(1);
  });

  it("中英混排且用词变形时仍有较高相似度", () => {
    const score = trigramSimilarity("deploy pipeline 配置", "deployment pipelines 配置");
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });

  it("长度不足 3 时退化为是否互相包含", () => {
    expect(trigramSimilarity("运动", "晚上运动")).toBe(1);
    expect(trigramSimilarity("运动", "运动")).toBe(1);
    expect(trigramSimilarity("ab", "xaby")).toBe(1);
    expect(trigramSimilarity("运动", "阅读")).toBe(0);
    expect(trigramSimilarity("a", "b")).toBe(0);
  });

  it("空串不产生相似度（没有证据就不给分）", () => {
    expect(trigramSimilarity("", "")).toBe(0);
    expect(trigramSimilarity("", "晚上运动")).toBe(0);
    expect(trigramSimilarity("晚上运动", "")).toBe(0);
    // 纯标点归一化后为空，同样视为没有可比较的内容
    expect(trigramSimilarity("？。！", "？。！")).toBe(0);
  });

  it("对称：sim(a, b) === sim(b, a)", () => {
    const pairs: Array<[string, string]> = [
      ["晚上精力不足", "晚上精力明显不足"],
      ["deploy pipeline 配置", "deployment pipelines 配置"],
      ["运动", "晚上运动"],
    ];
    for (const [a, b] of pairs) {
      expect(trigramSimilarity(a, b)).toBe(trigramSimilarity(b, a));
    }
  });

  it("超长文本不会崩，结果仍在 0–1 之间", () => {
    const long = "长文本记忆".repeat(4000);
    const score = trigramSimilarity(long, long);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("combineScores", () => {
  it("空输入得 0", () => {
    expect(combineScores([])).toBe(0);
  });

  it("按权重求和", () => {
    expect(
      combineScores([
        { value: 1, weight: 2 },
        { value: 0.5, weight: 4 },
      ]),
    ).toBe(4);
  });

  it("非有限值不参与求和（坏信号不能污染总分）", () => {
    expect(
      combineScores([
        { value: Number.NaN, weight: 3 },
        { value: 1, weight: 1 },
        { value: 1, weight: Number.POSITIVE_INFINITY },
      ]),
    ).toBe(1);
  });
});

describe("WEIGHTS", () => {
  it("词面权重高于模糊相似，模糊相似高于长期记忆加分", () => {
    expect(WEIGHTS.relevance).toBeGreaterThan(WEIGHTS.trigram);
    expect(WEIGHTS.trigram).toBeGreaterThan(WEIGHTS.longTerm);
    expect(WEIGHTS.longTerm).toBeGreaterThan(0);
    expect(WEIGHTS.importance).toBeGreaterThan(0);
    expect(WEIGHTS.recency).toBeGreaterThan(0);
  });

  it("近因沿用 0.99^小时，半衰期表达与它数值等价", () => {
    expect(RECENCY_DECAY).toBeCloseTo(0.99, 12);
    expect(0.5 ** (1 / RECENCY_HALF_LIFE_HOURS)).toBeCloseTo(RECENCY_DECAY, 12);
    expect(RECENCY_HALF_LIFE_HOURS).toBeCloseTo(68.97, 2);
  });
});

describe("scoreMemories 混合打分", () => {
  it("词面漏掉但字面相关的记忆，靠 trigram 反超无关键记忆", () => {
    const pool = [
      // 更近、同样重要，但和查询毫无字面关系：纯词面检索会把它排第一
      memory({
        id: "mem_lunch",
        content: "每天中午 12:30 吃午饭，饭后散步十分钟。",
        ageHours: 0,
      }),
      // 词面 0 命中（deployments ≠ deploy），只有字符 3-gram 相似
      memory({
        id: "mem_deploy",
        content: "我的 deploy pipeline 放在仓库根的 workflow 文件里。",
        ageHours: 24,
      }),
    ];

    const ranked = scoreMemories("deployments pipelines", pool, now);
    expect(ranked[0]?.id).toBe("mem_deploy");

    const deploy = ranked.find((item) => item.id === "mem_deploy");
    const lunch = ranked.find((item) => item.id === "mem_lunch");
    expect(deploy?.scores.relevance).toBe(0);
    expect(deploy?.scores.trigram).toBeGreaterThan(0.3);
    expect(lunch?.scores.trigram).toBe(0);
    // 近因确实站在无关记忆一边，结论不是靠"更近"赢的
    expect(lunch?.scores.recency).toBeGreaterThan(deploy?.scores.recency ?? 1);

    // 词面对这条查询毫无区分力：两条记忆都是 0 命中，光靠词面 + 近因只会选出更近的午饭记忆，
    // 这正是这次要补的漏检，所以用"只按近因排序"作为反证基线
    expect(lunch?.scores.relevance).toBe(0);
    const recencyOnly = [...ranked].sort(
      (a, b) => b.scores.recency - a.scores.recency,
    );
    expect(recencyOnly[0]?.id).toBe("mem_lunch");
  });

  it("整词命中压过模糊相似，也压过更高的 salience", () => {
    const pool = [
      memory({
        id: "mem_fuzzy",
        content: "deployment pipelines 配置示例",
        salience: 1,
        ageHours: 0,
      }),
      memory({
        id: "mem_exact",
        content: "deploy pipeline 只有一个 job",
        salience: 0.1,
        ageHours: 96,
      }),
    ];

    const ranked = scoreMemories("deploy pipeline", pool, now);
    expect(ranked[0]?.id).toBe("mem_exact");
  });

  it("同等条件下未过期的长期记忆多得 0.4 分", () => {
    const pool = [
      memory({
        id: "mem_temp",
        content: "这周临时调整了午休时间。",
        ageHours: 10,
        expiresAt: new Date(now.getTime() + 3_600_000),
      }),
      memory({
        id: "mem_stable",
        content: "这周临时调整了午休时间。",
        ageHours: 10,
        expiresAt: null,
      }),
    ];

    const ranked = scoreMemories("午休", pool, now);
    expect(ranked.map((item) => item.id)).toEqual(["mem_stable", "mem_temp"]);
    expect(ranked[0]?.scores.longTerm).toBe(1);
    expect(ranked[1]?.scores.longTerm).toBe(0);
    // 交换输入顺序，结论不变（否则"稳定"只是输入顺序的巧合）
    const reversed = scoreMemories("午休", [...pool].reverse(), now);
    expect(reversed.map((item) => item.id)).toEqual(["mem_stable", "mem_temp"]);
  });

  it("同分时按 id 兜底排序，结果不依赖数据库返回顺序", () => {
    const pool = [
      memory({ id: "mem_b", content: "同一句话。", ageHours: 5 }),
      memory({ id: "mem_a", content: "同一句话。", ageHours: 5 }),
    ];
    expect(scoreMemories("同一句话", pool, now).map((item) => item.id)).toEqual([
      "mem_a",
      "mem_b",
    ]);
    expect(
      scoreMemories("同一句话", [...pool].reverse(), now).map((item) => item.id),
    ).toEqual(["mem_a", "mem_b"]);
  });

  it("总分就是各项加权和，可以逐项解释", () => {
    const [scored] = scoreMemories(
      "晚上 运动",
      [memory({ id: "mem_one", content: "晚上 20:00 后运动", salience: 0.6, ageHours: 3 })],
      now,
    );
    expect(scored?.scores.total).toBeCloseTo(
      WEIGHTS.relevance * (scored?.scores.relevance ?? 0) +
        WEIGHTS.trigram * (scored?.scores.trigram ?? 0) +
        WEIGHTS.recency * (scored?.scores.recency ?? 0) +
        WEIGHTS.importance * (scored?.scores.importance ?? 0) +
        WEIGHTS.longTerm * (scored?.scores.longTerm ?? 0),
      10,
    );
  });

  it("空查询不给词面/模糊分，只按近因与重要性排", () => {
    const pool = [
      memory({ id: "mem_old_important", content: "先给例子再给定义。", salience: 1, ageHours: 200 }),
      memory({ id: "mem_new_plain", content: "晚上十点睡。", salience: 0.2, ageHours: 0 }),
    ];
    const ranked = scoreMemories("", pool, now);
    expect(ranked).toHaveLength(2);
    for (const item of ranked) {
      expect(item.scores.relevance).toBe(0);
      expect(item.scores.trigram).toBe(0);
      expect(Number.isFinite(item.scores.total)).toBe(true);
    }
    expect(ranked[0]?.id).toBe("mem_old_important");
  });

  it("空候选返回空数组", () => {
    expect(scoreMemories("任意查询", [], now)).toEqual([]);
  });

  it("单条候选也拿到非零总分（旧的 min-max 归一化会把它压成 0）", () => {
    const [scored] = scoreMemories(
      "晚上 运动",
      [memory({ id: "mem_only", content: "晚上 20:00 后精力低，运动连续跳过。", ageHours: 2 })],
      now,
    );
    expect(scored?.scores.relevance).toBe(1);
    expect(scored?.scores.total).toBeGreaterThan(0);
  });

  it("超长文本不会崩，分数仍是有限值", () => {
    const huge = memory({
      id: "mem_huge",
      content: "长文本记忆".repeat(4000) + " 运动",
      ageHours: 1,
    });
    const [scored] = scoreMemories("运动", [huge], now);
    expect(Number.isFinite(scored?.scores.total)).toBe(true);
    expect(scored?.scores.trigram).toBeGreaterThanOrEqual(0);
    expect(scored?.scores.trigram).toBeLessThanOrEqual(1);
  });

  it("近因随时间单调下降", () => {
    const [fresh] = scoreMemories("", [memory({ id: "a", content: "x", ageHours: 0 })], now);
    const [stale] = scoreMemories("", [memory({ id: "a", content: "x", ageHours: 168 })], now);
    expect(fresh?.scores.recency).toBeGreaterThan(stale?.scores.recency ?? 1);
  });
});
