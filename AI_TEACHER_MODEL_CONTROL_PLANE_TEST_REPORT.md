# AI Teacher GLM-5.3 Flash 混动 SUV 真实测试与根因分析报告

## 1. 结论

本轮业务测试结果判定为 **PARTIAL**，但不阻断以“模型管理页面与 LiteLLM 控制面”为边界提交 PR 2。

- 真实 Provider、LiteLLM 路由、Thinking + Tool、Candidate 生成、Official Validator 和终末交付链路均已真实执行，没有使用 Mock。
- 两次终末 Candidate 均通过 Official SysML v2 Validator，语法与语义检查为 0 diagnostics。
- 两次终末 Candidate 均未满足用户明确要求的模型覆盖：缺少 `port`、`connection`、`interface`、`attribute`，且四个指定系统的覆盖不完整。
- 首要根因不是 GLM-5.3 Flash 能力不足，也不是专业知识库缺失，而是 **公开版在澄清续跑后没有把完整任务来源投影给 Candidate Worker**。原始用户任务在 Main 层仍可见，但 Candidate Prompt 只携带当前澄清回答。
- 次要根因是终末成功条件仍以 Official Validator PASS 为主，没有把“用户明确要求是否全部覆盖”作为独立的交付检查。Validator 的行为正确，它本来就不负责判定整车架构任务是否完整。
- private 当前代码已经包含 `conversationContext`、`taskSources`、`confirmedTaskSources` 的 Worker 投影，而公开分支缺少这一组关键代码。因此，这不是“private 也一样、只是模型随机性不同”，而是本次公开移植确有关键业务上下文遗漏。

本报告将该问题登记为已知债务。PR 2 可以按模型控制面范围提交，但不得宣称已完成 AI Teacher 业务 Loop 对齐、混动 SUV 任务验收或版本发布验收。任务来源投影与同 Prompt 复测由下一轮专门 PR 处理。

## 2. 测试目标与边界

### 2.1 测试目标

验证公开版 AI Teacher 模型控制面升级后，是否能够通过 GLM-5.3 Flash 完成真实的 SysML v2 整车架构生成任务，并形成与用户原始要求一致的终末交付。

### 2.2 原始测试 Prompt

> 生成一个混动suv的整车架构模型，必须涵盖车辆主要的系统，如：动力总成、热管理、三电、自动驾驶等部分，生成的模型要具备部件定义，端口定义、连接关系定义等，必须正确使用part，port，connection，interface，attribute等建模元素。

该 Prompt 对以下内容给出了明确约束：

1. 系统对象：混动 SUV 整车架构。
2. 系统覆盖：动力总成、热管理、三电、自动驾驶。
3. 结构关系：部件、端口、连接关系。
4. 指定 SysML v2 构造：`part`、`port`、`connection`、`interface`、`attribute`。

混动拓扑没有在首轮中指定，但这只影响动力系统方案选择，不改变上述四类系统和五类语言构造的强制要求。

### 2.3 验收分层

| 层级 | 判定内容 | 本轮结果 |
| --- | --- | --- |
| Provider 能力 | 真实调用、流式、Tool、Thinking、结构化输出、Usage | PASS |
| SysML v2 语言有效性 | Official Validator syntax/semantic、diagnostics | PASS |
| 用户显式意图覆盖 | 四类系统与五类构造是否真实出现 | FAIL |
| 汽车领域工程质量 | 拓扑、接口方向、能量/控制关系是否工程合理 | 未进入正式评审 |
| 浏览器动态学生验收 | UI 中真实多轮交互、结果展示与应用 | 未完成 |

Official Validator PASS 只证明候选在本次 Validator 检查范围内语言有效，不证明用户任务完成，也不自动证明工程设计正确。

## 3. 测试环境与真实调用证据

### 3.1 模型与协议

- 业务 Alias：`ai-teacher-glm-flash`
- Provider 模型：`zai/glm-5.3-flash`
- Adapter Profile：`zai-glm.v1`
- Model Protocol Profile：`glm-5.3-standard-chat.v1`
- Main / Finalizer Reasoning：`provider-managed`
- 调用性质：真实 LLM，无 Mock、无固定响应替代

### 3.2 镜像构建结果

测试时构建并运行的镜像摘要：

| 服务 | 镜像摘要 |
| --- | --- |
| API | `sha256:950c92786118c78e0b9258d622919441f8a505f8226974037bc07337ef9a67e7` |
| Teacher | `sha256:3d57640486cc99df72130d7c56e0710f12fbd9215c8fb07d3fcd43febe57d762` |
| Web | `sha256:d5361f3a5249f4d141f7ca8089cf29480ed50b9b3df85439f76d9f556126ab14` |

### 3.3 Capability Probe

Deployment：`deployment_901554a4-4693-4356-8c6c-e1d1cc4249bf`

| 指标 | 结果 |
| --- | --- |
| 总耗时 | 23.123 s |
| Provider 调用 | 8 次 |
| 总 Token | 976 |
| Reasoning Token | 18 |
| Streaming | PASS |
| Tool Call | PASS |
| Thinking | PASS |
| Thinking + Tool | PASS |
| Structured Output | PASS |
| Usage | PASS |

该 Probe 证明 GLM-5.3 Flash 能通过当前协议完成所测能力，但不能替代长 Candidate、Repair、任务覆盖和最终业务验收。

## 4. 真实 AI Teacher 运行结果

原始 Prompt 触发了混动拓扑澄清。测试随后在同一线程给出澄清回答，并继续真实执行。

| 运行 | 澄清选择 | Run ID | 耗时 | Candidate 字符数 | `part` | `port` | `connection` | `interface` | `attribute` | Validator |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| A | 通用混动 | `run_dbf099a9-9dc5-452c-a40f-6d3dc865b5db` | 117.968 s | 505 | 10 | 0 | 0 | 0 | 0 | 0 diagnostics |
| B | 功率分流混动 | `run_d3c51a33-cc53-4844-b1ad-379156f2decf` | 130.808 s | 972 | 13 | 0 | 0 | 0 | 0 | 0 diagnostics |

两次运行都被系统标记为 `changed_delivered`、`validated_passed`、`complete`。这个状态对“Validator 已通过并交付候选”是准确的，但对“完整满足原始混动 SUV 任务”是不准确的。

## 5. 根因分析

### 5.1 首要根因：澄清续跑后的任务来源没有进入公开版 Candidate Prompt

公开版当前链路如下：

1. Agent Adapter 同时构造：
   - `question: buildAgentQuestion(...)`：包含同线程历史和当前问题，供 Main 使用；
   - `currentStudentQuestion: agentStudentQuestion(...)`：澄清续跑时优先取当前学生回答。
2. `createRunInputSnapshot()` 使用 `request.currentStudentQuestion ?? request.question` 作为 `resources.input.question`。
3. `projectWorkerTaskView()` 只把 `resources.input.question` 投影为 `task.question`。
4. `candidatePrompt()` 只发送 `studentQuestion: task.question`。

因此，在用户回答“通用混动”或“功率分流混动”后，Candidate Worker 的规范任务输入主要只剩这一条短回答。最初 Prompt 中的以下强约束没有进入 Candidate Prompt：

- 动力总成、热管理、三电、自动驾驶；
- `part`、`port`、`connection`、`interface`、`attribute`。

公开版 `authorizedTaskSources()` 虽然已经能构造 `root_user_request` 和 `clarification_user_answer`，但这些来源没有被冻结到 `RunInputSnapshot`，也没有投影进 `WorkerTaskView` 和 `candidatePrompt()`。这是典型的“上游已采集、下游未消费”。

### 5.2 private 对比：公开移植确实遗漏了关键业务代码

private 当前实现包含公开分支缺失的三段投影：

- `RunInputSnapshot.conversationContext`
- `RunInputSnapshot.taskSources`
- Candidate Prompt 中的 `conversationContext` 和 `confirmedTaskSources`

private 的 `projectWorkerTaskView()` 也会把上述内容传给 Worker。这使 Candidate 能同时看到当前澄清回答和经过服务端授权、Hash 绑定的原始任务来源。

所以，private 中“正常通过”与本轮公开测试失败并不矛盾。两者模型名称可以相同，但 Worker 实际获得的任务上下文并不相同。公开版当前不能宣称与 private 关键业务逻辑保持一致。

### 5.3 次要根因：成功条件没有独立检查用户意图覆盖

`runCandidateWorker()` 当前在 `validation.passed` 后直接形成 `validated_passed` WorkerResult。Repair 也只在 Validator 失败时启动。

这意味着：

- Candidate 只要语法/语义合法，就不会因为缺少用户明确要求的系统或构造而进入 Repair；
- 终末状态可以是 `complete`，即使任务覆盖明显不完整；
- Finalizer 会正确披露 Validator 的有限边界，但不会改变已选择的 Candidate。

工程语义 Review 已经明确知道“Validator PASS 不等于工程完整”，但公开 Policy 中 `semanticReview.enabled` 默认关闭；即使启用，它目前仍是非阻断软 Review，不能替代确定性的任务覆盖门。

### 5.4 Prompt 约束是否有问题

原始用户 Prompt 不是本次失败的主要原因。它已经两次使用“必须”，并明确列出系统范围和语言构造，约束强度足够。

Candidate 系统 Prompt 也写有“候选必须满足学生问题”和“学生明确要求的语言构造必须以真实 SysML v2 语义实现”。问题在于，澄清后 Candidate 没有收到完整的“学生问题”。

不过，Prompt 体系存在一个放大因素：`create` 模式强调“最小结构教学样例”，并规定除非学生明确要求，否则不要增加端口、连接等构造。当原始要求在 Worker 上下文中丢失后，这条最小化指令会把模型进一步推向只有 `part` 的最小结果。

因此准确结论是：

- **不是原始用户 Prompt 约束不足；**
- **是 Agent Loop 的上下文投影遗漏，使强约束没有到达 Candidate；**
- **最小化 Prompt 与缺失上下文叠加，放大了遗漏；**
- **终末交付门没有发现该遗漏。**

### 5.5 专业知识库是否是原因

测试环境没有激活 reviewed knowledge bundle，这会降低以下质量：

- 混动架构的工程分解深度；
- 三电、热管理与自动驾驶之间的典型接口覆盖；
- 端口方向、能量流、控制流和属性选择的合理性。

但它不能解释五类显式 SysML v2 构造中四类完全为零。用户已经在 Prompt 中逐字要求这些构造；即使没有汽车知识库，Candidate 也应至少生成与之对应的合法基础模型。

知识库是质量增强项，不应承担恢复丢失用户意图的职责。先补知识库而不修任务来源投影，只会让结果偶尔变好，不能形成稳定闭环。

## 6. 根因优先级

| 优先级 | 原因 | 证据强度 | 影响 |
| --- | --- | --- | --- |
| P0 | 公开版未把原始 Task Sources 投影给澄清后的 Candidate Worker | 代码直接证据 + 两次结果一致 | 原始强约束丢失 |
| P0 | Validator PASS 被直接映射为终末成功，缺少任务覆盖检查 | 代码直接证据 | 合法但不完整的模型被交付 |
| P1 | `create` 最小样例 Prompt 在显式要求丢失后产生反向偏置 | Prompt 与输出一致 | 候选退化为少量 `part` |
| P2 | reviewed knowledge bundle 未激活 | 环境事实 | 工程丰富度和领域合理性下降 |
| P3 | GLM-5.3 Flash 随机生成偏差 | 两次结果一致，且 Probe/Validator 正常 | 可能影响细节，不是主因 |

## 7. 修复与复测建议

### 7.1 下一轮用户意图连续性 PR 必须补齐

1. 从 private 有边界地移植 `conversationContext` 与 `taskSources`：
   - 冻结到 `RunInputSnapshot`；
   - 投影到 `WorkerTaskView`；
   - 在 Candidate Prompt 中发送 `confirmedTaskSources`；
   - 保留现有 sourceHash 与 taskAuthorizationRevisionHash 校验，禁止直接信任 LLM 或客户端自报 GoalRef。
2. 增加澄清续跑回归测试：
   - 根问题包含四类系统和五类构造；
   - 澄清回答仅为“功率分流混动”；
   - 断言 Candidate Prompt 同时包含根问题与澄清回答；
   - 断言两者来源关系分别为 `root_user_request` 和 `clarification_user_answer`。
3. 增加终末任务覆盖测试：至少在真实测试 Harness 中检查用户明确列举的系统和构造，不得只看 Validator PASS。
4. 保持 Official Validator 为语言硬门；不要把关键词计数冒充 SysML 语义验证。构造存在性可以作为明确需求覆盖证据，端口、连接、接口和属性的语义正确性仍由 Validator 与工程评审共同判断。

### 7.2 同 Prompt 真实复测门

修复后继续使用 `zai/glm-5.3-flash` 和完全相同的原始 Prompt，完成至少一次澄清续跑，并同时满足：

- Official Validator：syntax PASS、semantic PASS、0 diagnostics；
- 系统覆盖：动力总成、热管理、三电、自动驾驶均有真实模型元素；
- 构造覆盖：`part`、`port`、`connection`、`interface`、`attribute` 均有真实语义用法；
- 关系闭合：至少存在端口到端口的连接/接口实例，不以注释或名称冒充关系；
- 交付绑定：终末展示内容与通过 Validator 的 Candidate Hash 一致；
- 浏览器验收：动态学生流程中能看到、复制并应用完整候选。

## 8. PR 判定

| 项目 | 当前判定 |
| --- | --- |
| 模型控制面与 GLM-5.3 协议能力 | PASS |
| 真实镜像构建与服务链路 | PASS |
| Official Validator 语言验证 | PASS |
| private/public Candidate 任务上下文一致性 | FAIL |
| 用户显式意图覆盖 | FAIL |
| PR 2 可提交 | PASS WITH KNOWN DEBT（仅模型管理页面与 LiteLLM 控制面） |
| PR 2 可宣称 AI Teacher Loop 业务对齐 | BLOCK |
| 版本发布 | BLOCK |

人话版：模型和发动机都能正常工作，真正的问题是澄清之后，工单只把“选功率分流”递给了施工人员，却没有把最初那张“要有动力、热管理、三电、自动驾驶，还必须画端口和连接”的完整图纸一起递过去。施工人员做出了一份语法正确的小模型，验收机也正确地判定语法合格，但系统误把“语法合格”当成了“整车任务完成”。
