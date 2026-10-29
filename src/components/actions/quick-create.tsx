"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { money } from "@/lib/format";
import {
  assignableAgents,
  assigneeBlockLabel,
  AUDITOR_CONFLICT_MESSAGE,
  COST_AMOUNT_MESSAGE,
  COST_FORMAT_MESSAGE,
  planAdvancedFocus,
  validateTaskDraft,
  yuanToCents,
} from "@/lib/presentation/task-form";
import type { AdvancedField, TaskDraftErrors } from "@/lib/presentation/task-form";
import { goalLinkHint } from "@/lib/presentation/goal-view";
import { call } from "./shared";

const FIELD =
  "h-8 w-full rounded border border-line bg-panel px-2.5 text-label text-ink outline-none transition-colors focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40 placeholder:text-faint";
const FIELD_TEXTAREA =
  "w-full rounded border border-line bg-panel px-2.5 py-2 text-label text-ink outline-none transition-colors focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40 placeholder:text-faint resize-none";
const FIELD_INVALID =
  "border-danger/60 focus:border-danger/60 focus-visible:ring-danger/30";

type TaskErrors = TaskDraftErrors;

export function QuickCreate({
  agents,
  goals,
}: {
  agents: Array<{
    id: string;
    name: string;
    role: string;
    status: string;
    lifecycleStage: string;
  }>;
  goals: Array<{ id: string; title: string }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Progressive Disclosure: Step 1 (Core Inputs)
  const [taskTitle, setTaskTitle] = useState("");
  const [taskCriteria, setTaskCriteria] = useState("");
  const [taskDesc, setTaskDesc] = useState("");

  // Step 2 (Advanced Options)

  /*
   * Only Agents that can actually execute a task may be preselected: a retired
   * one is terminal and a trainee cannot take work before graduating, so a
   * default pointing at either is a task that would never run. The rule and the
   * dropdown's option labels come from the same helpers.
   */
  const assignable = assignableAgents(agents);
  const defaultAssignee =
    assignable.find((agent) => agent.role !== "auditor")?.id ??
    assignable[0]?.id ??
    "";
  const defaultAuditor =
    agents.find((agent) => agent.role === "auditor" && agent.id !== defaultAssignee)?.id ??
    agents.find((agent) => agent.role === "auditor")?.id ??
    agents.find((agent) => agent.id !== defaultAssignee)?.id ??
    "";

  const [taskAssignee, setTaskAssignee] = useState(defaultAssignee);
  const [taskAuditor, setTaskAuditor] = useState(defaultAuditor);
  const [taskAction, setTaskAction] = useState("internal");
  const [taskCostYuan, setTaskCostYuan] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Goal Creation Form State
  const [goalTitle, setGoalTitle] = useState("");
  const [goalWhy, setGoalWhy] = useState("");
  const [goalTarget, setGoalTarget] = useState("");
  const [goalHorizon, setGoalHorizon] = useState("6 weeks");
  const [goalDomain, setGoalDomain] = useState("learning");

  // Validation State & Field Refs
  const [errors, setErrors] = useState<TaskErrors>({});
  const titleRef = useRef<HTMLInputElement>(null);
  const criteriaRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const auditorRef = useRef<HTMLSelectElement>(null);
  const costRef = useRef<HTMLInputElement>(null);
  /*
   * A field inside the collapsed 「更多配置」 block cannot take focus while it is
   * closed, and calling `.focus()` right after `setAdvancedOpen(true)` runs
   * before React commits the open attribute — so the focus silently went
   * nowhere and a keyboard user was told "请指定验收者" with no way to reach it.
   * Park the target in a ref and focus it once the block is actually open.
   * A ref rather than state: this is a one-shot side effect, not render input.
   */
  const pendingFocusRef = useRef<AdvancedField | null>(null);

  useEffect(() => {
    if (!advancedOpen) return;
    const field = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (!field) return;
    (field === "auditor" ? auditorRef : costRef).current?.focus();
  }, [advancedOpen]);

  /*
   * The effect above only fires when `advancedOpen` *changes*. If the block is
   * already open — the person opened 「更多配置」 themselves, or this is a
   * second submit without touching the disclosure — setting it to `true` again
   * is a no-op, the effect never runs, and the error would be shown while
   * focus stayed on the submit button. So focus directly when it is already
   * open, and only park the target when an open is actually pending.
   */
  function focusAdvancedField(field: AdvancedField) {
    const plan = planAdvancedFocus(field, advancedOpen);
    if (plan.kind === "focus-now") {
      (plan.field === "auditor" ? auditorRef : costRef).current?.focus();
      return;
    }
    if (plan.kind === "open-then-focus") {
      pendingFocusRef.current = plan.field;
      setAdvancedOpen(true);
    }
  }

  // Payload value only; whether the amount is *acceptable* is decided by
  // `validateTaskDraft`, so the rule lives in one place. `null` means the field
  // is blank or unreadable, and the payload falls back to 0 for non-spend tasks.
  const taskCostCents = yuanToCents(taskCostYuan);

  const assigneeName =
    agents.find((agent) => agent.id === taskAssignee)?.name ?? "未指定";
  const auditorName =
    agents.find((agent) => agent.id === taskAuditor)?.name ?? "未指定";
  const selectedGoal = goals.find((goal) => goal.id === taskGoal);

  // Auditor !== Assignee conflict check
  const isAuditorConflict = Boolean(
    taskAssignee && taskAuditor && taskAssignee === taskAuditor,
  );

  // Parse acceptance criteria items count for execution preview
  const criteriaList = taskCriteria
    .split(/[\n;；]+/)
    .map((item) => item.trim().replace(/^[-*•\d+.)、\s]+/, "").trim())
    .filter(Boolean);
  const criteriaCount = criteriaList.length;

  // Auditor candidates: prioritize dedicated auditors, then all agents
  const auditorChoices =
    agents.length > 0
      ? [...agents].sort((a, b) => {
          if (a.role === "auditor" && b.role !== "auditor") return -1;
          if (a.role !== "auditor" && b.role === "auditor") return 1;
          return 0;
        })
      : [];

  // Instant field-level validation handlers
  function handleTitleChange(value: string) {
    setTaskTitle(value);
    if (errors.title && value.trim()) {
      setErrors((prev) => ({ ...prev, title: undefined }));
    }
  }

  function handleCriteriaChange(value: string) {
    setTaskCriteria(value);
    if (errors.acceptanceCriteria && value.trim()) {
      setErrors((prev) => ({ ...prev, acceptanceCriteria: undefined }));
    }
  }

  function handleDescChange(value: string) {
    setTaskDesc(value);
    if (errors.description && value.trim()) {
      setErrors((prev) => ({ ...prev, description: undefined }));
    }
  }

  function handleAssigneeChange(value: string) {
    setTaskAssignee(value);
    if (value && value === taskAuditor) {
      setErrors((prev) => ({
        ...prev,
        auditor: AUDITOR_CONFLICT_MESSAGE,
      }));
    } else if (errors.auditor === AUDITOR_CONFLICT_MESSAGE) {
      setErrors((prev) => ({ ...prev, auditor: undefined }));
    }
  }

  function handleAuditorChange(value: string) {
    setTaskAuditor(value);
    if (value && value === taskAssignee) {
      setErrors((prev) => ({
        ...prev,
        auditor: AUDITOR_CONFLICT_MESSAGE,
      }));
    } else if (errors.auditor) {
      setErrors((prev) => ({ ...prev, auditor: undefined }));
    }
  }

  function handleActionChange(value: string) {
    setTaskAction(value);
    if (value !== "spend") {
      setErrors((prev) => ({ ...prev, cost: undefined }));
    } else if (taskCostYuan.trim()) {
      const costCents = yuanToCents(taskCostYuan);
      if (costCents === null) {
        setErrors((prev) => ({ ...prev, cost: COST_FORMAT_MESSAGE }));
      } else if (costCents <= 0) {
        setErrors((prev) => ({ ...prev, cost: COST_AMOUNT_MESSAGE }));
      }
    }
  }

  function handleCostChange(value: string) {
    setTaskCostYuan(value);
    if (errors.cost) {
      const costCents = yuanToCents(value);
      if (costCents !== null && costCents > 0) {
        setErrors((prev) => ({ ...prev, cost: undefined }));
      }
    }
  }

  function validateTask(): boolean {
    const result = validateTaskDraft({
      title: taskTitle,
      acceptanceCriteria: taskCriteria,
      description: taskDesc,
      auditorId: taskAuditor,
      assigneeId: taskAssignee,
      actionType: taskAction,
      costYuan: taskCostYuan,
    });

    setErrors(result.errors);

    // An advanced field can only be focused once its block is open, so this
    // either focuses now (already open) or parks the target for the effect.
    if (result.focus === "auditor" || result.focus === "cost") {
      focusAdvancedField(result.focus);
      return false;
    }

    if (result.focus === "title") titleRef.current?.focus();
    else if (result.focus === "acceptanceCriteria") criteriaRef.current?.focus();
    else if (result.focus === "description") descRef.current?.focus();

    return result.valid;
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
        // Spend tasks are already validated above, so `null` here can only be
        // a non-spend task; 0 keeps the payload's integer contract.
        estimatedCostCents: taskAction === "spend" ? (taskCostCents ?? 0) : 0,
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
    <div className="space-y-3">
      {/* Task Creation Accordion */}
      <details className="rounded-md border border-line bg-panel2/40 px-3 py-2.5">
        <summary className="cursor-pointer text-label text-muted transition-colors hover:text-ink">
          <Plus className="mr-1 inline size-3 text-accent" /> 新建任务
        </summary>
        <form
          className="mt-3 space-y-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void createTask();
          }}
        >
          {/* Step 1 / Core Inputs */}
          <div className="space-y-2.5">
            {/* Task Title */}
            <div className="space-y-1">
              <label
                htmlFor="qc-task-title"
                className="flex items-center justify-between text-label font-medium text-ink"
              >
                <span>做一件什么事</span>
                <span className="text-eyebrow uppercase tracking-[0.16em] text-accent">
                  必填
                </span>
              </label>
              <input
                id="qc-task-title"
                ref={titleRef}
                value={taskTitle}
                onChange={(event) => handleTitleChange(event.target.value)}
                aria-required="true"
                aria-invalid={errors.title ? true : undefined}
                aria-describedby={errors.title ? "qc-title-error" : undefined}
                placeholder="例如：梳理本周上线的核心功能并撰写复盘文档"
                className={errors.title ? `${FIELD} ${FIELD_INVALID}` : FIELD}
              />
              {errors.title ? (
                <p
                  id="qc-title-error"
                  role="alert"
                  className="text-label text-danger"
                >
                  {errors.title}
                </p>
              ) : null}
            </div>

            {/* Acceptance Criteria */}
            <div className="space-y-1">
              <label
                htmlFor="qc-task-criteria"
                className="flex items-center justify-between text-label font-medium text-ink"
              >
                <span>怎么算完成 / 交付物标准</span>
                <span className="text-eyebrow uppercase tracking-[0.16em] text-accent">
                  必填
                </span>
              </label>
              <textarea
                id="qc-task-criteria"
                ref={criteriaRef}
                value={taskCriteria}
                onChange={(event) => handleCriteriaChange(event.target.value)}
                aria-required="true"
                aria-invalid={errors.acceptanceCriteria ? true : undefined}
                aria-describedby={
                  errors.acceptanceCriteria ? "qc-criteria-error" : undefined
                }
                placeholder="Auditor 按此标准判定通过或驳回（支持多条，例如：&#10;1. 产出复盘 Markdown 并包含核心指标&#10;2. 明确列出后续优化动作）"
                rows={3}
                className={
                  errors.acceptanceCriteria
                    ? `${FIELD_TEXTAREA} ${FIELD_INVALID}`
                    : FIELD_TEXTAREA
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

            {/* Scope / Description */}
            <div className="space-y-1">
              <label
                htmlFor="qc-task-desc"
                className="flex items-center justify-between text-label font-medium text-ink"
              >
                <span>补充说明 / 边界要求</span>
                <span className="text-eyebrow uppercase tracking-[0.16em] text-accent">
                  必填
                </span>
              </label>
              <textarea
                id="qc-task-desc"
                ref={descRef}
                value={taskDesc}
                onChange={(event) => handleDescChange(event.target.value)}
                aria-required="true"
                aria-invalid={errors.description ? true : undefined}
                aria-describedby={
                  errors.description ? "qc-description-error" : undefined
                }
                placeholder="描述这件事的背景、边界或无需覆盖的范围，Agent 会严格照此执行"
                rows={2}
                className={
                  errors.description
                    ? `${FIELD_TEXTAREA} ${FIELD_INVALID}`
                    : FIELD_TEXTAREA
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
          </div>

          {/* Step 2 / Advanced Options (折叠的「更多配置」) */}
          <details
            open={advancedOpen}
            onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
            className="rounded border border-line/70 bg-panel2/30 px-3 py-2 text-label"
          >
            <summary className="flex cursor-pointer select-none items-center justify-between text-label text-muted transition-colors hover:text-ink">
              <span className="flex items-center gap-1.5 font-medium">
                <ChevronRight
                  className={`size-3 text-faint transition-transform duration-200 ${
                    advancedOpen ? "rotate-90" : ""
                  }`}
                />
                更多配置
                <span className="text-faint font-normal">
                  （执行者、验收者、动作类型、目标）
                </span>
              </span>
              <span className="truncate text-faint max-w-[180px]">
                {assigneeName} · {auditorName}
              </span>
            </summary>

            <div className="mt-3 space-y-3 border-t border-line/50 pt-2.5">
              {/* Assignee & Auditor */}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div className="space-y-1">
                  <label
                    htmlFor="qc-task-assignee"
                    className="block text-label font-medium text-muted"
                  >
                    执行者 (Assignee)
                  </label>
                  <select
                    id="qc-task-assignee"
                    value={taskAssignee}
                    onChange={(event) => handleAssigneeChange(event.target.value)}
                    aria-label="执行 Agent"
                    className="h-8 w-full rounded border border-line bg-panel px-2 text-label text-ink outline-none transition-colors focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    {agents.map((agent) => {
                      const blocked = assigneeBlockLabel(agent);
                      return (
                        <option
                          key={agent.id}
                          value={agent.id}
                          disabled={blocked !== null}
                        >
                          {agent.name} {agent.role === "auditor" ? "(监督者)" : ""}
                          {blocked !== null ? " — " + blocked : ""}
                        </option>
                      );
                    })}
                  </select>
                  {assignable.length === 0 ? (
                    <p className="text-label text-danger">
                      现在没有可以接单的 Agent：先恢复在岗的成员，或让学徒转正。
                    </p>
                  ) : (
                    <p className="text-label text-faint">负责拆解与执行具体任务</p>
                  )}
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="qc-task-auditor"
                    className="block text-label font-medium text-muted"
                  >
                    验收者 (Auditor)
                  </label>
                  <select
                    id="qc-task-auditor"
                    ref={auditorRef}
                    value={taskAuditor}
                    onChange={(event) => handleAuditorChange(event.target.value)}
                    aria-label="验收 Agent"
                    aria-invalid={Boolean(errors.auditor || isAuditorConflict)}
                    aria-describedby={
                      errors.auditor || isAuditorConflict
                        ? "qc-auditor-error"
                        : undefined
                    }
                    className={
                      errors.auditor || isAuditorConflict
                        ? "h-8 w-full rounded border border-danger/60 bg-panel px-2 text-label text-ink outline-none focus:border-danger/60 focus-visible:ring-2 focus-visible:ring-danger/30"
                        : "h-8 w-full rounded border border-line bg-panel px-2 text-label text-ink outline-none transition-colors focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
                    }
                  >
                    {auditorChoices.map((agent) => {
                      const isConflict = agent.id === taskAssignee;
                      return (
                        <option
                          key={agent.id}
                          value={agent.id}
                          disabled={isConflict}
                        >
                          {agent.name}{" "}
                          {agent.role === "auditor" ? "(独立监督)" : ""}{" "}
                          {isConflict ? "— 与执行者冲突" : ""}
                        </option>
                      );
                    })}
                  </select>
                  {isAuditorConflict || errors.auditor ? (
                    <p
                      id="qc-auditor-error"
                      role="alert"
                      className="flex items-center gap-1 text-label text-danger"
                    >
                      <AlertCircle className="size-3 shrink-0" />
                      <span>
                        {errors.auditor ||
                          `${AUDITOR_CONFLICT_MESSAGE}（需独立制衡）`}
                      </span>
                    </p>
                  ) : (
                    <p className="text-label text-faint">依据验收标准客观把关</p>
                  )}
                </div>
              </div>

              {/* Action Type & Associated Goal */}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div className="space-y-1">
                  <label
                    htmlFor="qc-task-action"
                    className="block text-label font-medium text-muted"
                  >
                    动作类型 (Action Type)
                  </label>
                  <select
                    id="qc-task-action"
                    value={taskAction}
                    onChange={(event) => handleActionChange(event.target.value)}
                    aria-label="动作类型"
                    className="h-8 w-full rounded border border-line bg-panel px-2 text-label text-ink outline-none transition-colors focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <option value="internal">内部任务</option>
                    <option value="external">产生外部调用</option>
                    <option value="spend">产生模型或外包花费</option>
                  </select>
                  <p className="text-label text-faint">
                    {taskAction === "internal"
                      ? "内部任务无外部副作用"
                      : taskAction === "external"
                      ? "将产生日历或外部集成调用"
                      : "涉及实际预算支出与审批校验"}
                  </p>
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="qc-task-goal"
                    className="block text-label font-medium text-muted"
                  >
                    关联目标 (Associated Goal)
                  </label>
                  <select
                    id="qc-task-goal"
                    value={taskGoal}
                    onChange={(event) => setTaskGoal(event.target.value)}
                    aria-label="关联目标"
                    className="h-8 w-full rounded border border-line bg-panel px-2 text-label text-ink outline-none transition-colors focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <option value="">无目标（独立单项）</option>
                    {goals.map((goal) => (
                      <option key={goal.id} value={goal.id}>
                        {goal.title}
                      </option>
                    ))}
                  </select>
                  <p className="text-label text-faint">
                    {goalLinkHint(taskGoal || null)}
                  </p>
                </div>
              </div>

              {/* Estimated Cost (only when actionType === 'spend') */}
              {taskAction === "spend" ? (
                <div className="space-y-1 rounded border border-accent/20 bg-accent/[0.03] p-2.5">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="qc-task-cost"
                      className="text-label font-medium text-ink"
                    >
                      预估花费金额（元）
                    </label>
                    <span className="text-eyebrow uppercase tracking-[0.16em] text-accent">
                      必填
                    </span>
                  </div>
                  <input
                    id="qc-task-cost"
                    ref={costRef}
                    type="number"
                    min="0.01"
                    step="0.01"
                    inputMode="decimal"
                    value={taskCostYuan}
                    onChange={(event) => handleCostChange(event.target.value)}
                    aria-required="true"
                    aria-invalid={Boolean(errors.cost)}
                    aria-describedby={
                      errors.cost ? "qc-cost-error" : "qc-cost-hint"
                    }
                    placeholder="例如：5.00"
                    className={
                      errors.cost ? `${FIELD} ${FIELD_INVALID}` : FIELD
                    }
                  />
                  {errors.cost ? (
                    <p
                      id="qc-cost-error"
                      role="alert"
                      className="text-label text-danger"
                    >
                      {errors.cost}
                    </p>
                  ) : (
                    <p id="qc-cost-hint" className="text-label text-faint">
                      金额用于审批和预算校验，超过审批阈值需要审批。
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          </details>

          {/* Execution Preview / Task Summary */}
          <div className="rounded border border-line bg-panel2/60 px-3 py-2 text-label">
            <div className="flex flex-wrap items-center gap-1.5 text-muted">
              <span className="text-eyebrow uppercase tracking-[0.16em] text-faint">
                执行预览
              </span>
              <span aria-hidden="true" className="text-faint">|</span>
              {assignable.length > 0 ? (
                <span>
                  将由 <strong className="font-medium text-ink">{assigneeName}</strong> 执行
                </span>
              ) : (
                <span className="text-danger">没有可以接单的 Agent</span>
              )}
              <span>·</span>
              <span>
                由{" "}
                <strong
                  className={
                    isAuditorConflict
                      ? "font-medium text-danger"
                      : "font-medium text-ink"
                  }
                >
                  {auditorName}
                </strong>{" "}
                验收
              </span>
              <span>·</span>
              <span>
                包含{" "}
                <strong className="mono font-medium text-ink">
                  {criteriaCount}
                </strong>{" "}
                项交付标准
              </span>
              {taskAction === "spend" && taskCostCents !== null && taskCostCents > 0 ? (
                <>
                  <span>·</span>
                  <span>
                    预估花费{" "}
                    {/* Echo the parsed amount, not the raw input: typing 「12元」
                        used to preview "¥12元" while the submit path silently
                        charged 12 — the preview must spell the amount the app
                        will actually charge, or say nothing. */}
                    <strong className="mono font-medium text-ink">
                      {money(taskCostCents)}
                    </strong>
                  </span>
                </>
              ) : null}
              {selectedGoal ? (
                <>
                  <span>·</span>
                  <span
                    className="truncate max-w-[150px]"
                    title={selectedGoal.title}
                  >
                    关联目标:{" "}
                    <span className="text-ink">{selectedGoal.title}</span>
                  </span>
                </>
              ) : null}
            </div>
            {isAuditorConflict ? (
              <div className="mt-1.5 flex items-center gap-1 text-label text-danger">
                <AlertCircle className="size-3 shrink-0" />
                <span>验收者不能与执行者相同，请在「更多配置」中调整。</span>
              </div>
            ) : null}
          </div>

          {/* Action Row */}
          <div className="flex items-center justify-between pt-1">
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null}
              type="submit"
            >
              {busy === "task" ? "正在创建..." : "创建任务"}
            </Button>
            <span className="text-label text-faint">
              按下 Enter 或点击创建
            </span>
          </div>
        </form>
      </details>

      {/* Goal Creation Accordion */}
      <details className="rounded-md border border-line bg-panel2/40 px-3 py-2.5">
        <summary className="cursor-pointer text-label text-muted transition-colors hover:text-ink">
          <Plus className="mr-1 inline size-3 text-accent" /> 新建目标
        </summary>
        <form
          className="mt-3 space-y-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            void createGoal();
          }}
        >
          <div className="space-y-1">
            <label
              htmlFor="qc-goal-title"
              className="block text-label font-medium text-muted"
            >
              目标标题
            </label>
            <input
              id="qc-goal-title"
              value={goalTitle}
              onChange={(event) => setGoalTitle(event.target.value)}
              aria-label="目标标题"
              placeholder="目标标题"
              className={FIELD}
            />
          </div>
          <div className="space-y-1">
            <label
              htmlFor="qc-goal-why"
              className="block text-label font-medium text-muted"
            >
              为什么（一句话）
            </label>
            <input
              id="qc-goal-why"
              value={goalWhy}
              onChange={(event) => setGoalWhy(event.target.value)}
              aria-label="为什么"
              placeholder="为什么（一句话）"
              className={FIELD}
            />
          </div>
          <div className="space-y-1">
            <label
              htmlFor="qc-goal-target"
              className="block text-label font-medium text-muted"
            >
              可验收的结果
            </label>
            <input
              id="qc-goal-target"
              value={goalTarget}
              onChange={(event) => setGoalTarget(event.target.value)}
              aria-label="可验收的结果"
              placeholder="可验收的目标"
              className={FIELD}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label
                htmlFor="qc-goal-horizon"
                className="block text-label font-medium text-muted"
              >
                目标周期
              </label>
              <input
                id="qc-goal-horizon"
                value={goalHorizon}
                onChange={(event) => setGoalHorizon(event.target.value)}
                aria-label="目标周期"
                className={FIELD}
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="qc-goal-domain"
                className="block text-label font-medium text-muted"
              >
                目标领域
              </label>
              <select
                id="qc-goal-domain"
                value={goalDomain}
                onChange={(event) => setGoalDomain(event.target.value)}
                aria-label="目标领域"
                className="h-8 w-full rounded border border-line bg-panel px-2 text-label text-ink outline-none transition-colors focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <option value="learning">学习</option>
                <option value="health">健康</option>
                <option value="work">工作</option>
                <option value="life">生活</option>
              </select>
            </div>
          </div>
          <div className="pt-1">
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
              {busy === "goal" ? "正在创建..." : "创建目标"}
            </Button>
          </div>
        </form>
      </details>

      {msg ? <div className="text-label text-muted">{msg}</div> : null}
    </div>
  );
}
