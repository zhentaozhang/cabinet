export const DEMO_USER_ID = process.env.DEMO_USER_ID ?? "usr_zhen";

/**
 * Whether the demo reset endpoint exists in this deployment.
 *
 * 两个开关，不是一个：`seedDemo()` 会 TRUNCATE 31 张表（含 users），而生产之外
 * 的鉴权是 fail-open 的（AUTH_REQUIRED 未设时 getApiUserId 直接返回
 * DEMO_USER_ID），只开 DEMO_RESET_ENABLED 就等于给任何能访问这个实例的人一个
 * 匿名清库按钮。演示模式也必须显式打开，生产环境无论开关如何都不成立。
 *
 * 这个判断从 route 里搬出来，是因为侧边栏要问同一件事：按钮原来只看「有没有
 * 登录」，默认配置（DEMO_MODE=false、DEMO_RESET_ENABLED=false、AUTH_REQUIRED
 * 未设）下它照样显示「重置演示数据」，点下去必然 404 —— 一个永远失败的动作不
 * 该画在界面上。可见性与可执行性必须是同一个函数。
 */
export function demoResetAllowed(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.DEMO_MODE === "true" &&
    process.env.DEMO_RESET_ENABLED === "true"
  );
}
