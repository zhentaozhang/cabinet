/**
 * Every path the web client is allowed to call.
 *
 * Keeping paths in the shared contract means the physical split (moving the
 * route handlers into `apps/api`) never requires hunting string literals in
 * components.
 */
export const API_ROUTES = {
  // Read models — one endpoint per screen aggregate, never one per table.
  today: "/api/today",
  review: "/api/review",
  cabinet: "/api/cabinet",
  memory: "/api/memory",
  memoryItem: (id: string) => `/api/memories/${id}`,  councilBoard: "/api/council",

  // Per-entity read models.
  agentDetail: (id: string) => `/api/agents/${id}`,
  agentCard: (id: string) => `/api/agents/${id}/card`,
  taskDetail: (id: string) => `/api/tasks/${id}`,
  councilDetail: (id: string) => `/api/council/${id}`,

  // Mutations.
  tasks: "/api/tasks",
  taskRun: (id: string) => `/api/tasks/${id}/run`,
  taskAudit: (id: string) => `/api/tasks/${id}/audit`,
  taskPromote: (id: string) => `/api/tasks/${id}/promote`,
  taskCancel: (id: string) => `/api/tasks/${id}/cancel`,
  taskSubmit: (id: string) => `/api/tasks/${id}/submit`,
  taskManifest: (id: string) => `/api/tasks/${id}/manifest`,
  taskAcceptance: (id: string) => `/api/tasks/${id}/acceptance`,
  taskOverride: (id: string) => `/api/tasks/${id}/override`,
  taskPolicyPreview: (id: string) => `/api/tasks/${id}/policy-preview`,
  taskDone: (id: string) => `/api/tasks/${id}/done`,
  learningNextTask: "/api/learning/next-task",
  learningMastery: "/api/learning/mastery",
  reviewsWeekly: "/api/reviews/weekly",
  shell: "/api/shell",
  approval: (id: string) => `/api/approvals/${id}`,
  grant: (id: string) => `/api/grants/${id}`,
  agent: (id: string) => `/api/agents/${id}`,
  autonomy: (id: string) => `/api/autonomy/${id}`,
  apprenticeExam: "/api/apprentice/exam",
  apprenticeGraduate: "/api/apprentice/graduate",
  apprenticeObservations: "/api/apprentice/observations",
  checkin: "/api/checkin",
  brief: "/api/brief",
  councilDecision: (id: string) => `/api/council/${id}`,
  councils: "/api/councils",
  goals: "/api/goals",
  goalTransition: (id: string) => `/api/goals/${id}`,
  insight: (id: string) => `/api/insights/${id}`,
  reflect: "/api/reflect",
  audit: "/api/audit",
  connectors: "/api/connectors",
  notifications: "/api/notifications",
  notificationsRun: "/api/notifications/run",
  connectorTest: "/api/connectors/test",
  verifyAudit: "/api/audit/verify",
  setup: "/api/setup",
  account: "/api/account",
  demoReset: "/api/demo/reset",
  exportData: "/api/export",
} as const;
