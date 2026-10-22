/**
 * Provenance vocabulary shared by persistence, DTOs and UI labels.
 *
 * A value answers "where did this record come from?", not "is it useful?".
 * Unknown legacy rows stay explicit instead of being inferred as real.
 */
export const SOURCE_TYPES = [
  "user_input",
  "system_event",
  "external_import",
  "model_generated",
  "rule_generated",
  "demo_fixture",
  "legacy_unknown",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export function isSimulatedSource(source: string): boolean {
  return source === "demo_fixture" || source === "rule_generated";
}

export function sourceLabel(source: string): string {
  switch (source) {
    case "user_input":
      return "用户输入";
    case "system_event":
      return "系统记录";
    case "external_import":
      return "外部导入";
    case "model_generated":
      return "模型生成";
    case "rule_generated":
      return "规则生成";
    case "demo_fixture":
      return "演示数据";
    default:
      return "来源未知";
  }
}
