"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { call } from "./shared";

const FIELD =
  "h-8 w-full rounded border border-line bg-panel px-2 text-label text-ink outline-none focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40";
const FIELD_INVALID = "border-danger/60";

type TaskErrors = {
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  auditor?: string;
};

export function QuickCreate({
  agents,
  goals,
}: {
  agents: Array<{ id: string; name: string; role: string }>;
  goals: Array<{ id: string; title: string }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDesc, setTaskDesc] = useState("");
  const [taskCriteria, setTaskCriteria] = useState("");
  const [taskAssignee, setTaskAssignee] = useState(
    agents.find((agent) => agent.role !== "auditor")?.id ?? agents[0]?.id ?? "",
  );
  const [taskAuditor, setTaskAuditor] = useState(
    agents.find((agent) => agent.role === "auditor")?.id ?? "",
  );
  const [taskAction, setTaskAction] = useState("internal");
  const [taskCostYuan, setTaskCostYuan] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [goalTitle, setGoalTitle] = useState("");
  const [goalWhy, setGoalWhy] = useState("");
  const [goalTarget, setGoalTarget] = useState("");
  const [goalHorizon, setGoalHorizon] = useState("6 weeks");
  const [goalDomain, setGoalDomain] = useState("learning");
  const [errors, setErrors] = useState<TaskErrors>({});

  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const criteriaRef = useRef<HTMLTextAreaElement>(null);
  const auditorRef = useRef<HTMLSelectElement>(null);

  const taskCostCents = Math.round(Number.parseFloat(taskCostYuan) * 100);
  const hasValidCost =
    taskAction !== "spend" ||
    (Number.isFinite(taskCostCents) && taskCostCents > 0);
  const assigneeName =
    agents.find((agent) => agent.id === taskAssignee)?.name ?? "未指派";

  /**
   * Only the three fields that carry human intent are required up front; the
   * rest already have defaults. Validation reports every problem at once and
   * moves focus to the first one instead of greying out the submit button.
   */
  function validateTask(): boolean {
    const next: TaskErrors = {};
    if (!taskTitle.trim()) next.title = "写一句能被验收的标题";
    if (!taskDesc.trim()) next.description = "描述范围，Agent 会照着做";
    if (!taskCriteria.trim())
      next.acceptanceCriteria = "验收标准决定 Auditor 怎么判";
    if (!hasValidCost) next.acceptanceCriteria = "金额需要大于 0";
    if (taskAssignee && taskAssignee === taskAuditor)
      next.auditor = "验收者不能是执行者";

    setErrors(next);
    if (next.title) titleRef.current?.focus();
    else if (next.description) descRef.current?.focus();
    else if (next.acceptanceCriteria) criteriaRef.current?.focus();
    else if (next.auditor) auditorRef.current?.focus();
    return Object.keys(next).length === 0;
  }

  async function submit(
    url: string,
    body: Record<string, unknown>,
    label: string,
  ) {
    setBusy(label);
    setMsg(null);
    const data = await call(url, "POST", body);
    setBusy(null);
    setMsg(data.ok ? "已创建" : (data.error ?? "创建失败"));
    if (!data.ok) {
      toast.error(data.error ?? "创建失败");
      return;
    }
    toast.success(label === "task" ? "任务已创建" : "目标已创建");
    if (label === "task") {
      setTaskTitle("");
      setTaskDesc("");
      setTaskCriteria("");
      setTaskGoal("");
      setTaskCostYuan("");
      setErrors({});
    } else {
      setGoalTitle("");
      setGoalWhy("");
      setGoalTarget("");
    }
    router.refresh();
  }

  async function createTask() {
    if (!validateTask()) return;
    await submit(
      "/api/tasks",
      {
        title: taskTitle,
        description: taskDesc,
        acceptanceCriteria: taskCriteria,
        assigneeId: taskAssignee,
        auditorId: taskAuditor,
        actionType: taskAction,
        resource: taskAction === "external" ? "calendar" : "task",
        estimatedCostCents: taskAction === "spend" ? taskCostCents : 0,
        goalId: taskGoal || null,
        estimateMin: 25,
      },
      "task",
    );
  }

  async function createGoal() {
    await submit(
      "/api/goals",
      {
        title: goalTitle,
        why: goalWhy,
        target: goalTarget,
        horizon: goalHorizon,
        domain: goalDomain,
      },
      "goal",
    );
  }

  return (
    <div className="space-y-2">
      <details className="rounded-md border border-line bg-panel2/40 px-3 py-2">
        <summary className="cursor-pointer text-label text-muted">
          <Plus className="mr-1 inline size-3" /> 新建任务
        </summary>
        <form
          className="mt-3 space-y-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void createTask();
          }}
        >
          <div className="space-y-1">
            <input
              ref={titleRef}
              value={taskTitle}
              onChange={(event) => setTaskTitle(event.target.value)}
              aria-label="任务标题"
              aria-required
              aria-invalid={errors.title ? true : undefined}
              aria-describedby={errors.title ? "qc-title-error" : undefined}
              placeholder="任务标题"
              className={errors.title ? `${FIELD} ${FIELD_INVALID}` : FIELD}
            />
            {errors.title ? (
              <p id="qc-title-error" role="alert" className="text-label text-danger">
                {errors.title}
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <textarea
              ref={descRef}
              value={taskDesc}
              onChange={(event) => setTaskDesc(event.target.value)}
              aria-label="任务描述"
              aria-required
              aria-invalid={errors.description ? true : undefined}
              aria-describedby={
                errors.description ? "qc-description-error" : undefined
              }
              placeholder="描述这件事的范围"
              rows={2}
              className={
                errors.description
                  ? `${FIELD} resize-none py-1.5 ${FIELD_INVALID}`
                  : `${FIELD} resize-none py-1.5`
              }
            />
            {errors.description ? (
              <p
                id="qc-description-error"
                role="alert"
                className="text-label text-danger"
              >
                {errors.description}
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <textarea
              ref={criteriaRef}
              value={taskCriteria}
              onChange={(event) => setTaskCriteria(event.target.value)}
              aria-label="验收标准"
              aria-required
              aria-invalid={errors.acceptanceCriteria ? true : undefined}
              aria-describedby={
                errors.acceptanceCriteria ? "qc-criteria-error" : undefined
              }
              placeholder="验收标准：Auditor 按这条判定通过或驳回"
              rows={2}
              className={
                errors.acceptanceCriteria
                  ? `${FIELD} resize-none py-1.5 ${FIELD_INVALID}`
                  : `${FIELD} resize-none py-1.5`
              }
            />
            {errors.acceptanceCriteria ? (
              <p
                id="qc-criteria-error"
                role="alert"
                className="text-label text-danger"
              >
                {errors.acceptanceCriteria}
              </p>
            ) : null}
          </div>

          <details className="rounded border border-line/70 px-2 py-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-label text-faint">
              <ChevronRight className="size-3" />
              更多设置 · 执行者默认 {assigneeName}
            </summary>
            <div className="mt-2 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={taskAssignee}
                  onChange={(event) => setTaskAssignee(event.target.value)}
                  aria-label="执行 Agent"
                  className="h-8 rounded border border-line bg-panel px-2 text-label text-ink"
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <select
                  ref={auditorRef}
                  value={taskAuditor}
                  onChange={(event) => setTaskAuditor(event.target.value)}
                  aria-label="验收 Agent"
                  aria-invalid={errors.auditor ? true : undefined}
                  aria-describedby={errors.auditor ? "qc-auditor-error" : undefined}
                  className="h-8 rounded border border-line bg-panel px-2 text-label text-ink"
                >
                  {agents
                    .filter((agent) => agent.role === "auditor")
                    .map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                </select>
              </div>
              {errors.auditor ? (
                <p id="qc-auditor-error" role="alert" className="text-label text-danger">
                  {errors.auditor}
                </p>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={taskAction}
                  onChange={(event) => setTaskAction(event.target.value)}
                  aria-label="动作类型"
                  className="h-8 rounded border border-line bg-panel px-2 text-label text-ink"
                >
                  <option value="internal">内部动作</option>
                  <option value="external">外部动作</option>
                  <option value="spend">支出</option>
                </select>
                <select
                  value={taskGoal}
                  onChange={(event) => setTaskGoal(event.target.value)}
                  aria-label="关联目标"
                  className="h-8 rounded border border-line bg-panel px-2 text-label text-ink"
                >
                  <option value="">无目标</option>
                  {goals.map((goal) => (
                    <option key={goal.id} value={goal.id}>
                      {goal.title}
                    </option>
                  ))}
                </select>
              </div>
              {taskAction === "spend" ? (
                <div className="space-y-1">
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    inputMode="decimal"
                    value={taskCostYuan}
                    onChange={(event) => setTaskCostYuan(event.target.value)}
                    aria-label="预计支出金额（元）"
                    placeholder="金额（元）"
                    className={FIELD}
                  />
                  <p className="text-label text-muted">
                    金额用于审批和预算校验，超过审批阈值需要审批。
                  </p>
                  {taskCostYuan.trim() && !hasValidCost ? (
                    <p className="text-label text-danger">金额需大于 0。</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </details>

          <Button size="sm" variant="primary" disabled={busy !== null} type="submit">
            创建任务
          </Button>
        </form>
      </details>

      <details className="rounded-md border border-line bg-panel2/40 px-3 py-2">
        <summary className="cursor-pointer text-label text-muted">
          <Plus className="mr-1 inline size-3" /> 新建目标
        </summary>
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createGoal();
          }}
        >
          <input
            value={goalTitle}
            onChange={(event) => setGoalTitle(event.target.value)}
            aria-label="目标标题"
            placeholder="目标标题"
            className={FIELD}
          />
          <input
            value={goalWhy}
            onChange={(event) => setGoalWhy(event.target.value)}
            aria-label="为什么"
            placeholder="为什么（一句话）"
            className={FIELD}
          />
          <input
            value={goalTarget}
            onChange={(event) => setGoalTarget(event.target.value)}
            aria-label="可验收的结果"
            placeholder="可验收的目标"
            className={FIELD}
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              value={goalHorizon}
              onChange={(event) => setGoalHorizon(event.target.value)}
              aria-label="目标周期"
              className={FIELD}
            />
            <select
              value={goalDomain}
              onChange={(event) => setGoalDomain(event.target.value)}
              aria-label="目标领域"
              className="h-8 rounded border border-line bg-panel px-2 text-label text-ink"
            >
              <option value="learning">学习</option>
              <option value="health">健康</option>
              <option value="work">工作</option>
              <option value="life">生活</option>
            </select>
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={
              busy !== null ||
              !goalTitle.trim() ||
              !goalWhy.trim() ||
              !goalTarget.trim()
            }
            type="submit"
          >
            创建目标
          </Button>
        </form>
      </details>

      {msg ? <div className="text-label text-muted">{msg}</div> : null}
    </div>
  );
}
