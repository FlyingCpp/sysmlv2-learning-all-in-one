# AI Teacher 执行与管理架构

本文件描述开源实现与验收边界。实现入口为 `apps/api/server.js`、
`apps/teacher/server.js`、`apps/teacher/agent/intent-v2-execution.mts`。

## AI Teacher LLM Schema Governance

LLM 负责理解、建议和自然语言；服务端负责 ID、权限、状态、hash、持久化和发布。
Schema 合法仅证明结构合法，不证明业务完成或模型正确。
当前唯一已确认硬Schema例外是无法由服务端确定性派生、且具有副作用的类型化Tool参数。
无效 Tool 参数必须拒绝该次动作，不能否定已有回答和已验证候选。
Candidate/Repair 生成完整候选文本；服务端绑定内容 hash、Official Validator 结果和交付状态。
建议性结构化输出必须允许确定性降级，不得增加未授权业务硬门。

## 目标逻辑

学生请求 → 已认证 API → 任务上下文 → Main 编排 → Candidate/Repair →
Official Validator → 绑定候选与回答 → 客户端展示与应用。
资源策略由管理端提交，经所有适用 Owner 应用、回读一致后成为 Active Desired。

## 当前物理执行

- API 在新请求前等待启动策略协调；会话管理读操作使用最小管理上下文。
- 每个 Run 经 `runIntentV2Execution` 创建执行状态和 Ledger；Main 调用
  `runIntentOrchestratorV2`，按需委派 Candidate、Repair 和 Final Answer Worker。
  Worker 结果经服务端结果绑定后回到 Main；调用次数由执行路径和策略上限决定。
- 每个任务生命周期由 `task-lifecycle-contract.js` 与 `task-contract-runtime.mts`
  管理，持久化到 Conversation Store。任务可跨 Run 延续；不能把每个 Run 当作独立完成任务。
- Candidate 文本规范化后绑定内容与工作区 hash，交付必须绑定官方校验凭据；
  历史候选恢复核对来源 Run、候选内容、工作区 hash 和代码块证明。
- 终态回答与 delivery pending/delivered 状态分开保存，恢复不能伪造已经交付。
- 账户在对话开始时按剩余额度准入，Reservation 用于幂等和结算绑定；
  不预扣模型预测 Token。准入后按实际消耗结算，因此单轮可能超过剩余额度。
- Schema 24 资源策略迁移旧字段并解析环境内模型 Alias。API 协调 Teacher 与
  Validator；发布失败尝试恢复上一策略并记录补偿状态。Validator 内部接口
  使用独立于公开健康检查的 Token 认证，缺少认证时拒绝读写。
- 传输使用 Undici Dispatcher，截止由业务 AbortSignal 控制；网络错误仍上报。

## 迁移差距与验证边界

开源 Core 保留无 Provider 的基础功能；Full 保留 `AI_TEACHER_REQUIRE_ACTIVE_BUNDLE=false`
的公开启动契约。未配置审核知识库时不会伪造知识检索证据。课程与知识包仍限于已公开资产。
本次未调整已公开 PlantUML 渲染算法，只补齐 Validator 资源策略 Owner 接口。

源码测试和 Mock 只能证明确定性边界。真实 Provider 工具协议、Chrome 多轮学习效果、
候选实际应用与真实数据库恢复必须单独验收；没有该证据时不得标为已通过。
涉及 SysML 提示的依据为标准库 `StandardViewDefinitions.sysml` 和现有官方校验回归，
不能将支持的渲染类型宣称为语言全部语义。

## 变更记录

- 2026-09-05：迁移任务生命周期、候选交付恢复、业务截止、资源策略应用回读、
  管理界面与额度准入；保留开源部署和内容边界。
