"use client";

/**
 * 故意抛错的测试页面（任务 10.9 验证用，路由 `/error-demo`）。
 *
 * 它只用于验证页面级故障隔离：渲染期抛错后应当只有内容区被替换成错误提示，
 * 导航与顶部栏保持可用，重试 / 切页即可恢复。
 * 从设置页的「诊断」区域点进来（客户端跳转），错误才会落到页面的错误边界上。
 */
export default function ErrorDemoPage(): React.ReactElement {
  throw new Error("page-fault-isolation-demo");
}