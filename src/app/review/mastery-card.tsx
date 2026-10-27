import { Badge, Card, CardHeader, EmptyState, Progress } from "@/components/ui";
import { API_ROUTES } from "@/contracts/routes";
import { serverApi } from "@/lib/api/server";
import { pct, shortDate } from "@/lib/format";

/**
 * /review 上的掌握度卡片。
 *
 * 保持 server component：这张卡片没有任何交互（看一眼就知道哪个主题该复习），
 * 加 use client 只会把一条本可以在服务端拼好的 HTML 变成浏览器的 JS 和一次
 * 额外的水合。
 *
 * 取数走自己的只读 API 而不是直接查库：页面和 API 是两份契约，直接查库会让
 * "接口返回什么"在页面这里悄悄漂移（比如忘了转 ISO 字符串）。代价是一次
 * 同源 fetch，而 /review 本来就是 force-dynamic。
 */

type TopicView = {
  topicKey: string;
  label: string;
  mastery: number;
  attempts: number;
  correct: number;
  intervalDays: number;
  dueAt: string | null;
  isDue: boolean;
  lastReviewedAt: string | null;
};

type Overview = { topics: TopicView[]; dueCount: number };

/**
 * 手写的形状校验，不用 zod：前端包不该为了一次读接口塞进一个 schema 库
 * （src/lib/api/client.ts 的 Parser 就是为这个留的）。字段缺失时抛错，
 * client 会把它变成一句可展示的失败提示，而不是让页面渲染出 undefined。
 */
function parseOverview(value: unknown): Overview {
  const record = (value ?? {}) as { topics?: unknown; dueCount?: unknown };
  if (!Array.isArray(record.topics)) throw new Error("topics 不是数组");

  const topics = record.topics.map((raw): TopicView => {
    const topic = (raw ?? {}) as Record<string, unknown>;
    if (typeof topic.topicKey !== "string" || typeof topic.label !== "string") {
      throw new Error("主题缺少 topicKey/label");
    }
    const number = (key: string): number => {
      const candidate = topic[key];
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
        throw new Error(`主题 ${topic.topicKey} 的 ${key} 不是数字`);
      }
      return candidate;
    };
    return {
      topicKey: topic.topicKey,
      label: topic.label,
      mastery: number("mastery"),
      attempts: number("attempts"),
      correct: number("correct"),
      intervalDays: number("intervalDays"),
      dueAt: typeof topic.dueAt === "string" ? topic.dueAt : null,
      isDue: topic.isDue === true,
      lastReviewedAt:
        typeof topic.lastReviewedAt === "string" ? topic.lastReviewedAt : null,
    };
  });

  return {
    topics,
    dueCount:
      typeof record.dueCount === "number" && Number.isFinite(record.dueCount)
        ? record.dueCount
        : 0,
  };
}

/** 一屏能读完的行数；再多就是把"复习节奏"变成一张要滚动的表。 */
const VISIBLE_TOPICS = 6;

export async function MasteryCard({ timezone }: { timezone: string }) {
  const api = await serverApi();
  const result = await api.query(API_ROUTES.learningMastery, parseOverview);

  // 读不到就只让这张卡片说清楚，不能让整页 500：/review 的其余部分
  // （本周结论、审计记录）不依赖掌握度，替用户把整页弄丢是更坏的选择。
  if (!result.ok) {
    return (
      <Card>
        <CardHeader eyebrow="Mastery" title="掌握度与复习节奏" />
        <div className="px-5 py-4">
          <EmptyState
            tone="danger"
            title="掌握度暂时读不到"
            hint={`${result.error}。这不影响本页其他内容；刷新可以重试。`}
          />
        </div>
      </Card>
    );
  }

  const { topics, dueCount } = result.data;
  const visible = topics.slice(0, VISIBLE_TOPICS);

  return (
    <Card>
      <CardHeader
        eyebrow="Mastery"
        title="掌握度与复习节奏"
        right={
          dueCount > 0 ? (
            <Badge tone="accent">{dueCount} 个主题该复习了</Badge>
          ) : (
            <Badge tone="neutral">间隔重复 · SM-2</Badge>
          )
        }
      />
      {topics.length === 0 ? (
        <div className="px-5 py-4">
          <EmptyState title="还没有复习记录——完成一次学习任务验收后开始累计" />
        </div>
      ) : (
        <>
          <div className="divide-y divide-line">
            {visible.map((topic, index) => {
              const headingId = `mastery-topic-${index}`;
              const percent = topic.mastery * 100;
              return (
                <div key={topic.topicKey} className="px-5 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <div
                      id={headingId}
                      className="min-w-0 truncate text-label font-medium text-ink"
                    >
                      {topic.label}
                    </div>
                    <span className="mono shrink-0 text-label tabular-nums text-muted">
                      {pct(percent)}
                    </span>
                  </div>
                  <Progress
                    className="mt-2"
                    value={percent}
                    labelledBy={headingId}
                    tone={topic.isDue ? "accent" : "teal"}
                  />
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-faint">
                    <span>
                      练习 {topic.attempts} 次 · 答对 {topic.correct} 次
                    </span>
                    <span>间隔 {topic.intervalDays} 天</span>
                    {/* 逾期用 accent 而不是 danger：错过复习不是错误，
                        只是"该看一眼了"，红色会把提醒读成告警。 */}
                    <span className={topic.isDue ? "text-accent" : undefined}>
                      {topic.isDue
                        ? `已逾期 · 原定 ${shortDate(topic.dueAt, timezone)}`
                        : `下次复习 ${shortDate(topic.dueAt, timezone)}`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-2.5 text-label text-faint">
            <span>
              共 {topics.length} 个主题，这里按掌握度从低到高列前 {VISIBLE_TOPICS} 个。
            </span>
            <span>这不是第二件承诺：到期只影响复习顺序，不改变上面那一件事。</span>
          </div>
        </>
      )}
    </Card>
  );
}
