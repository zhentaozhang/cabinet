"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { call } from "./shared";

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

  const taskCostCents = Math.round(Number.parseFloat(taskCostYuan) * 100);
  const hasValidCost =
    taskAction !== "spend" ||
    (Number.isFinite(taskCostCents) && taskCostCents > 0);

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
    if (data.ok) {
      if (label === "task") {
        setTaskTitle("");
        setTaskDesc("");
        setTaskCriteria("");
        setTaskGoal("");
        setTaskCostYuan("");
      } else {
        setGoalTitle("");
        setGoalWhy("");
        setGoalTarget("");
      }
      router.refresh();
    }
  }

  async function createTask() {
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
        <summary className="cursor-pointer text-micro text-muted">
          <Plus className="mr-1 inline size-3" /> 新建任务
        </summary>
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createTask();
          }}
        >
          <input
            value={taskTitle}
            onChange={(event) => setTaskTitle(event.target.value)}
            aria-label="任务标题"
            placeholder="任务标题"
            className="h-8 w-full rounded border border-line bg-panel px-2 text-micro text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
          <textarea
            value={taskDesc}
            onChange={(event) => setTaskDesc(event.target.value)}
            aria-label="任务描述"
            placeholder="描述"
            rows={2}
            className="w-full resize-none rounded border border-line bg-panel px-2 py-1.5 text-micro text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
          <textarea
            value={taskCriteria}
            onChange={(event) => setTaskCriteria(event.target.value)}
            aria-label="验收标准"
            placeholder="验收标准"
            rows={2}
            className="w-full resize-none rounded border border-line bg-panel px-2 py-1.5 text-micro text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              value={taskAssignee}
              onChange={(event) => setTaskAssignee(event.target.value)}
            aria-label="执行 Agent"
              className="h-8 rounded border border-line bg-panel px-2 text-micro text-ink"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <select
              value={taskAuditor}
              onChange={(event) => setTaskAuditor(event.target.value)}
            aria-label="验收 Agent"
              className="h-8 rounded border border-line bg-panel px-2 text-micro text-ink"
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
          <div className="grid grid-cols-2 gap-2">
            <select
              value={taskAction}
              onChange={(event) => setTaskAction(event.target.value)}
            aria-label="动作类型"
              className="h-8 rounded border border-line bg-panel px-2 text-micro text-ink"
            >
              <option value="internal">内部动作</option>
              <option value="external">外部动作</option>
              <option value="spend">支出</option>
            </select>
            <select
              value={taskGoal}
              onChange={(event) => setTaskGoal(event.target.value)}
            aria-label="关联目标"
              className="h-8 rounded border border-line bg-panel px-2 text-micro text-ink"
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
                className="h-8 w-full rounded border border-line bg-panel px-2 text-micro text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
              <p className="text-mini text-muted">
                金额用于审批和预算校验，超过审批阈值需要审批。
              </p>
              {taskCostYuan.trim() && !hasValidCost ? (
                <p className="text-mini text-danger">金额需大于 0。</p>
              ) : null}
            </div>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={
              busy !== null ||
              !taskTitle.trim() ||
              !taskDesc.trim() ||
              !taskCriteria.trim() ||
              !taskAssignee ||
              !taskAuditor ||
              taskAssignee === taskAuditor ||
              !hasValidCost
            }
            type="submit"
          >
            创建任务
          </Button>
        </form>
      </details>

      <details className="rounded-md border border-line bg-panel2/40 px-3 py-2">
        <summary className="cursor-pointer text-micro text-muted">
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
            className="h-8 w-full rounded border border-line bg-panel px-2 text-micro text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
          <input
            value={goalWhy}
            onChange={(event) => setGoalWhy(event.target.value)}
            aria-label="为什么"
            placeholder="为什么（一句话）"
            className="h-8 w-full rounded border border-line bg-panel px-2 text-micro text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
          <input
            value={goalTarget}
            onChange={(event) => setGoalTarget(event.target.value)}
            aria-label="可验收的结果"
            placeholder="可验收的目标"
            className="h-8 w-full rounded border border-line bg-panel px-2 text-micro text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              value={goalHorizon}
              onChange={(event) => setGoalHorizon(event.target.value)}
            aria-label="目标周期"
              className="h-8 rounded border border-line bg-panel px-2 text-micro text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            <select
              value={goalDomain}
              onChange={(event) => setGoalDomain(event.target.value)}
            aria-label="目标领域"
              className="h-8 rounded border border-line bg-panel px-2 text-micro text-ink"
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

      {msg ? <div className="text-mini text-muted">{msg}</div> : null}
    </div>
  );
}
