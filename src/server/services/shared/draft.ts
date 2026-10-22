export function draftFor(
  agentRole: string,
  taskTitle: string,
  priorRuns: number,
  hasRejection = false,
): { title: string; content: string } {
  if (agentRole === "researcher") {
    return {
      title: `${taskTitle} · 资料卡`,
      content: `# ${taskTitle}

## 结论
RAG 的核心不是"把文档塞进 prompt"，而是"召回、重排、约束生成"三件事。

## 证据
1. Retrieval-Augmented Generation for LLMs: A Survey
   https://arxiv.org/abs/2312.10997
2. RAG 的评估应以 recall@k、precision、faithfulness 为主。
   来源：https://arxiv.org/abs/2312.10997

## 不确定
- rerank 的具体延迟取决于模型和批量大小，需要实测。`,
    };
  }

  if (agentRole === "coach" && (taskTitle.includes("评估") || taskTitle.includes("练习"))) {
    const rubric =
      hasRejection
        ? `

## 评分标准（rubric）
| 维度 | 0 分 | 1 分 | 2 分 |
|---|---|---|---|
| 概念准确 | 定义错误 | 定义基本正确 | 定义准确且有例子 |
| 指标理解 | 混淆 recall/precision | 能区分 | 能说明权衡 |
| rerank | 不知道 | 知道用途 | 能说出代价与替代 |
| 评估设计 | 无 | 有题目 | 有题目 + 参考答案 + 评分标准 |

> 总分 ≥6/8 视为通过。`
        : `

> 备注：本版本尚未附评分标准。`;
    return {
      title: `${taskTitle} · v${priorRuns + 1}`,
      content: `# ${taskTitle}

1. recall@k 的定义是什么？举一个检索例子。
2. precision 和 recall 如何权衡？
3. rerank 解决什么问题？代价是什么？
4. 如何构造 20 条问题的评估集？
5. 模型答对但引用错了，算不算成功？

## 参考答案
1. 前 k 个结果中相关文档的比例……
2. 提高 recall 往往引入噪声，precision 下降……
3. rerank 用 cross-encoder 精排，代价是延迟……
4. 从真实问题采样，标注 gold chunk……
5. 不算；引用错误视为幻觉。${rubric}`,
    };
  }

  if (agentRole === "treasurer") {
    return {
      title: `${taskTitle} · 预算表`,
      content: `# 本周学习预算

| 项目 | 金额 | 备注 |
|---|---:|---|
| 课程试学 | ¥199 | 7 天可退 |
| 工具订阅 | ¥0 | 已有 |
| 资料 | ¥81 | 本月剩余 |
| **合计** | **¥280 / ¥600** | 剩余 ¥320 |

## 结论
本周不超支；年包 ¥599 会超支，建议只买月付。`,
    };
  }

  if (agentRole === "auditor") {
    return {
      title: `${taskTitle} · 审计记录`,
      content: `# 审计记录

- 验收标准：已逐条对照
- 证据：已附来源
- 结论：见审计结果`,
    };
  }

  if (agentRole === "apprentice") {
    return {
      title: `${taskTitle} · 技能草案`,
      content: `# 技能草案：检索评估练习设计

## 步骤
1. 读取 mentor 的 5 次成功运行
2. 提取题目结构：定义题 / 对比题 / 场景题
3. 为每题生成参考答案
4. 生成评分标准（rubric）
5. 自检：覆盖 recall / precision / rerank

## 护栏
- 不得编造引用
- 每题必须有评分标准`,
    };
  }

  if (agentRole === "critic") {
    return {
      title: `${taskTitle} · 风险清单`,
      content: `# 风险清单

- 任务粒度仍可能过大
- 评估集只有 5 题，统计意义不足
- 没有留出集，容易过拟合`,
    };
  }

  return {
    title: `${taskTitle} · 计划`,
    content: `# ${taskTitle}

## 本周目标
- 完成检索基础 + chunking
- 每天 25–45 分钟
- 周三晚上不排任务

## 验收
- 每个任务有产物
- 周末能做一次 10 题自测`,
  };
}
