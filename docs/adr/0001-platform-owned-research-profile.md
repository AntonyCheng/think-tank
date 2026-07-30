---
status: accepted
---

# 由平台拥有 Research Profile 契约

AO YAML、TypeScript 编排器和 Python 研究服务之间使用平台定义且带版本的 `ResearchProfile`，不直接暴露或透传 GPTR 原始 `Config`。这会增加一层显式映射，但能使编排产物不受上游字段名和默认值变化影响，并让尚未接入的 GPTR 能力通过统一的能力门控被明确拒绝，而不是被静默忽略；模型、凭据、端点和报告篇幅等非研究策略继续由现有设置或 AO 任务约束管理。
