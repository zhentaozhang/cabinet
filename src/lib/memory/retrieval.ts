import { and, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";
import {
  clamp01,
  combineScores,
  trigramSimilarity,
  type ScorePart,
} from "./rerank";

export type RetrievalCandidate = {
  id: string;
  content: string;
  salience: number;
  createdAt: Date;
  lastConfirmedAt: Date | null;
  /**
   * 到期时间，null 表示长期记忆。可选是为了让纯函数调用方（单测、离线重算）
   * 不必伪造这一列；缺省按"没有到期时间"处理。
   */
  expiresAt?: Date | null;
};

export type MemoryScores = {
  /** 词面命中率：查询里的整词有多大比例出现在记忆里（0–1）。 */
  relevance: number;
  /** 字符 3-gram 的 Dice 相似度（0–1），接住"换了个说法但字面共享"的记忆。 */
  trigram: number;
  /** 近因，半衰期式衰减（0–1），1 表示刚刚确认过。 */
  recency: number;
  /** salience，用户自己标定的重要性（0–1）。 */
  importance: number;
  /** 是否为未过期的长期记忆（0 或 1）。 */
  longTerm: number;
  /** 上述各项的加权和，逐项可解释（见 WEIGHTS）。 */
  total: number;
};

export type ScoredMemory<T extends RetrievalCandidate> = T & {
  scores: MemoryScores;
};

/** 每小时的保留率，沿用旧实现：recency = RECENCY_DECAY ** 小时数。 */
export const RECENCY_DECAY = 0.99;

/**
 * 近因的半衰期（小时）：recency = 0.5 ** (小时数 / 69.0)。
 *
 * 它和 RECENCY_DECAY ** 小时数 数值等价（69.0 = ln0.5 / ln0.99）。
 * 换成半衰期式只是为了让公式能读出来："三天前的记忆大约值一半"。
 * 参数没变，所以历史排序口径不会因为这次改造漂移。
 */
export const RECENCY_HALF_LIFE_HOURS = Math.log(0.5) / Math.log(RECENCY_DECAY);

/**
 * 混合检索权重。
 *
 * 排序口径沿用 Generative Agents（relevance : recency : importance = 3 : 0.5 : 2），
 * 把原来单一路的 relevance 拆成两路，并给长期记忆一点补偿：
 *
 * - relevance 3：整词命中，精度最高——同一个词出现基本就是同一件事，
 *   所以它是唯一能单独压过"高 salience + 最新"的权重。
 * - trigram 1.2：字符级模糊相似，专门补词面的漏检。取值理由：实测
 *   "无共同整词但字面相关"的记忆 trigram 落在 0.4–0.7，贡献 0.5–0.85，
 *   刚好能反超 24–48 小时的近因差（0.5 * (1 - 0.78) ≈ 0.11 到 0.25），
 *   又远小于一次整词命中的 3——模糊匹配不该翻掉精确命中。
 * - recency 0.5：近因只做微调，不主导排序（旧实现同样如此）。
 * - importance 2：salience 是用户自己标定的，比机器统计出的字面特征更权威；
 *   但它压不过整词命中，否则"重要但无关"会挤掉"次要但正好相关"。
 * - longTerm 0.4：没有到期时间说明这条知识稳定，给一点补偿。刻意取最小值：
 *   一条完全不相关的长期记忆靠它最多拿 0.4 分，翻不过一次整词命中（3），
 *   所以它不是救济无关记忆的后门。
 */
export const WEIGHTS = {
  relevance: 3,
  trigram: 1.2,
  recency: 0.5,
  importance: 2,
  longTerm: 0.4,
} as const;

/** 粗筛上限：进入打分的候选行数。打分是 O(候选数 × 文本长度) 的纯 JS 计算。 */
export const COARSE_CANDIDATE_LIMIT = 200;

/** 词面预筛最多用几个 token：每个 token 是一个 ILIKE 参数，太多会让 SQL 变胖。 */
const LEXICAL_PREFILTER_TOKENS = 8;

/**
 * 中文按词切、英文按词切，统一小写。
 *
 * 单字 token 丢掉：中文里"的/了/我"这类单字几乎不携带区分度，
 * 留着它们会让任意两条记忆都"相关"。
 */
function tokenize(text: string): string[] {
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const tokens: string[] = [];
  for (const part of segmenter.segment(text.toLowerCase())) {
    const token = part.segment.trim();
    if (token.length < 2) continue;
    if (!/[\p{L}\p{N}]/u.test(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

function tokenOverlap(queryTokens: Set<string>, content: string): number {
  if (queryTokens.size === 0) return 0;
  const contentTokens = new Set(tokenize(content));
  let hits = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.size;
}

/**
 * "长期"= 没有到期时间。带 expiresAt 的记忆只是暂时有效，不算稳定知识；
 * 已经过期的行由 SQL 过滤掉，这里不给分也看不到它们。
 */
function longTermScore(candidate: RetrievalCandidate): number {
  return candidate.expiresAt == null ? 1 : 0;
}

/**
 * 纯检索打分。无 IO、无副作用：同一组输入（含 now）必定得到同一顺序。
 *
 * total = 3·relevance + 1.2·trigram + 0.5·recency + 2·importance + 0.4·longTerm
 *
 * 不再做 min-max 归一化：五路信号本身都已经落在 0–1，直接加权就能解释；
 * 而归一化会让"分数"依赖同批候选——只有一条候选时所有项被压成 0，
 * 有多条时"最不相关"那条的 relevance 也被改成 0 而不是它真实的命中率。
 */
export function scoreMemories<T extends RetrievalCandidate>(
  query: string,
  candidates: T[],
  now: Date = new Date(),
): Array<ScoredMemory<T>> {
  const queryTokens = new Set(tokenize(query));

  const scored = candidates.map((candidate) => {
    const anchor = candidate.lastConfirmedAt ?? candidate.createdAt;
    const hours = Math.max(0, (now.getTime() - anchor.getTime()) / 3_600_000);
    const signals = {
      relevance: tokenOverlap(queryTokens, candidate.content),
      // 查询没有任何有效词时（空串、纯标点）不做模糊匹配：哈希后的查询
      // 只剩标点，任何共享的排版字符都会凭空造出相似度。
      trigram:
        queryTokens.size === 0
          ? 0
          : trigramSimilarity(query, candidate.content),
      recency: 0.5 ** (hours / RECENCY_HALF_LIFE_HOURS),
      importance: clamp01(candidate.salience),
      longTerm: longTermScore(candidate),
    };

    const parts: ScorePart[] = [
      { value: signals.relevance, weight: WEIGHTS.relevance },
      { value: signals.trigram, weight: WEIGHTS.trigram },
      { value: signals.recency, weight: WEIGHTS.recency },
      { value: signals.importance, weight: WEIGHTS.importance },
      { value: signals.longTerm, weight: WEIGHTS.longTerm },
    ];

    return {
      ...candidate,
      scores: { ...signals, total: combineScores(parts) },
    };
  });

  return scored.sort((a, b) => {
    if (b.scores.total !== a.scores.total) return b.scores.total - a.scores.total;
    // 同分时用 id 兜底：否则顺序取决于数据库返回行的物理顺序，
    // 同一份数据两次查询可能给出不同记忆，run 里记录的上下文就不可复现了。
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * 可选的重排钩子：拿到查询与候选池（只含 id 与 content，模型只需要文本），
 * 返回记忆 id 的先后顺序。本轮不接真模型，由调用方注入。
 */
export type RerankFn = (
  query: string,
  items: Array<{ id: string; content: string }>,
) => Promise<string[]>;

export type MemoryRetrievalOptions = {
  limit?: number;
  now?: Date;
  /** Agent performing the retrieval. Memories it owns are always visible. */
  agentId?: string;
  /**
   * Domains of user-level memories (those with no owning agent) this agent may
   * read. Private memories owned by other agents stay hidden.
   */
  scopes?: string[];
  /**
   * 不传就完全走纯混合打分：不额外调用、不额外查询，与接入重排之前一致；
   * 传了就按它返回的顺序取头部。
   */
  rerank?: RerankFn;
};

/** 可见性过滤：本 agent 的记忆，加上它有权读的用户级记忆。 */
function buildVisibilityFilter(options: MemoryRetrievalOptions): SQL | undefined {
  const visibility: SQL[] = [];
  if (options.agentId) {
    visibility.push(eq(memories.agentId, options.agentId));
  }
  if (options.scopes && options.scopes.length > 0) {
    visibility.push(
      options.scopes.includes("*")
        ? isNull(memories.agentId)
        : (and(
            isNull(memories.agentId),
            inArray(memories.domain, options.scopes),
          ) as SQL),
    );
  }
  if (visibility.length === 0) return undefined;
  if (visibility.length === 1) return visibility[0];
  return or(...visibility) as SQL;
}

const LIKE_SPECIAL_CHARS = /[\\%_]/g;

/** ILIKE 的通配符要转义，否则查询里的 % 会匹配整库。 */
function escapeLike(token: string): string {
  return token.replace(LIKE_SPECIAL_CHARS, (char) => "\\" + char);
}

/**
 * 词面粗筛：把"整词出现过"的行排到 LIMIT 前面。
 *
 * 旧实现只写了 .limit(200) 而没有 order by，等于按物理行顺序截断：记忆一多，
 * 一条真正相关的旧记忆会排在 200 行之后被直接丢掉，打分连看都看不到它。
 * 这里用 ILIKE 做词面优先，其余位置按近因补齐；模糊相似度由 JS 那层负责，
 * 不引入 pg_trgm——本仓库没有该扩展的迁移，也不允许新增运行时依赖。
 */
function lexicalPrefilter(query: string): SQL | undefined {
  const tokens = [...new Set(tokenize(query))]
    // 长 token 区分度高，先占住有限的参数位。
    .sort((a, b) => b.length - a.length)
    .slice(0, LEXICAL_PREFILTER_TOKENS);
  if (tokens.length === 0) return undefined;

  const patterns = tokens.map((token) => {
    const pattern = "%" + escapeLike(token) + "%";
    return sql`${memories.content} ILIKE ${pattern}`;
  });
  return or(...patterns) as SQL | undefined;
}

export async function retrieveMemories(
  userId: string,
  query: string,
  options: MemoryRetrievalOptions = {},
): Promise<Array<ScoredMemory<typeof memories.$inferSelect>>> {
  // 有效期过滤与打分共用同一个时间基准：两处时钟不一致时，会出现
  // "刚过期的记忆进了打分池"这种没人能解释的结果。
  const now = options.now ?? new Date();

  const lexicalRank = lexicalPrefilter(query);
  const orderBy: SQL[] = [
    // 词面命中的行先进入打分池：没有这一层，LIMIT 就只是"随便截 200 行"。
    ...(lexicalRank ? [sql`${lexicalRank} desc`] : []),
    sql`coalesce(${memories.lastConfirmedAt}, ${memories.createdAt}) desc`,
    // 兜底：同一时刻的行要有确定顺序，否则粗筛结果不可复现。
    sql`${memories.id} asc`,
  ];

  const rows = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        eq(memories.status, "active"),
        isNull(memories.validTo),
        or(isNull(memories.expiresAt), gt(memories.expiresAt, now)),
        buildVisibilityFilter(options),
      ),
    )
    .orderBy(...orderBy)
    .limit(COARSE_CANDIDATE_LIMIT);

  const scored = scoreMemories(query, rows, now);
  const limit = options.limit ?? 8;

  // 不传 rerank 就直接返回：多一次异步调用就是多一次"本来不需要的失败点"。
  if (!options.rerank) return scored.slice(0, limit);

  const ordered = await options.rerank(
    query,
    scored.map((memory) => ({ id: memory.id, content: memory.content })),
  );
  return applyRerankOrder(scored, ordered).slice(0, limit);
}

/**
 * 把重排结果的 id 顺序映射回记忆对象。
 *
 * 只做重排，不做增删：返回里不存在的 id 忽略、重复的只认第一次出现，
 * 没被点到的记忆按原打分顺序接在后面。这样即使模型只回了前 3 条，
 * 检索结果也不会凭空变少，而"模型乱给 id"最坏退化成不重排。
 */
export function applyRerankOrder<T extends { id: string }>(
  scored: readonly T[],
  orderedIds: readonly string[],
): T[] {
  const byId = new Map(scored.map((item) => [item.id, item]));
  const used = new Set<string>();
  const reranked: T[] = [];

  for (const id of orderedIds) {
    const item = byId.get(id);
    if (!item || used.has(id)) continue;
    used.add(id);
    reranked.push(item);
  }
  for (const item of scored) {
    if (!used.has(item.id)) reranked.push(item);
  }

  return reranked;
}
