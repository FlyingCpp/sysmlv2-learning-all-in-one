# SynFeld

[中文](#中文) · [English](#english) · [完整部署指南 / Deployment Guide](DEPLOYMENT.md)

## 中文

SynFeld 是一个面向 SysML v2 初学者、系统工程师和 MBSE 实践者的开源学习平台。它把知识导读、课程练习、文本建模、规则检查、Official Validator 和真实 AI 教学能力组织在同一个工程中，帮助学习者从“理解概念”逐步走到“写出并验证模型”。

当前公开版本为 **v0.1.0**，包含一个示例课程包和一个示例知识包，并提供可复现的 Core 与 Full 本地部署契约。

### 在线体验

**[打开 SynFeld 在线体验](https://www.sysforgeai.com/)**

- 完整体验需要使用一个有效且由你本人合法使用的邮箱完成基础注册。
- 注册流程仅包含邮箱和密码，没有复杂的身份验证步骤。
- 页面也提供游客入口；游客、普通注册用户和获授权用户的能力可能不同。
- AI 功能需要注册并获得相应权限。

> 在线体验仅通过正式 HTTPS 地址提供。若浏览器显示证书不受信任或连接不安全，请勿继续注册、输入密码或上传内容。

体验服务不承诺 SLA，也可能随版本升级重置测试数据。请勿上传涉密信息、商业机密、个人敏感信息或未获授权的工程模型。

### 可以体验什么

1. 阅读“SysML v2 工程扫盲与导读”，建立系统工程、MBSE 和 SysML v2 的基本认识。
2. 学习“SysML v2 电动汽车建模基础”课程中的结构、接口、行为、需求和验证。
3. 在建模工作台修改 Starter 模型。
4. 运行课程规则和 Official Validator，获得可定位的诊断结果。
5. 完成电动汽车综合项目，建立结构、需求满足关系与验证关系。
6. 在 Full 或托管服务中使用真实 AI Teacher，并用 Validator 和工程评审复核建议。

### 核心能力

- 渐进式课程：可编辑模型、学习步骤、提示和检查规则。
- 知识包：可浏览的概念、术语、参考资料和学习主题。
- SysML v2 建模工作台：文本模型编辑、课程上下文和诊断反馈。
- 双层验证：课程学习规则 + Official SysML v2 Validator。
- AI Teacher：仅在 Full 档位启用，并强制通过 LiteLLM 连接真实 Provider；Core 不启动 Teacher。
- 中英文界面与可扩展的课程包、知识包边界。

AI Teacher 的建议不是语言正确性或工程正确性的最终证据。正式模型仍应经过 Official Validator、项目规则和工程评审。

### v0.1.0 内容

| 类型 | 内容 |
| --- | --- |
| 示例课程包 | SysML v2 电动汽车建模基础 `2.2.0`，32 个课节 + 1 个综合项目 |
| 示例知识包 | SysML v2 工程扫盲与导读 `1.1.0` |
| 平台 | Web、API、Teacher、Validator 源代码与共享契约 |
| 部署 | Core 与 Full Docker Compose、本地数据库、LiteLLM、迁移与验收脚本 |
| 测试 | 公开边界、部署契约、课程内容、API、Teacher、Validator 和 Web 回归 |

公开仓不包含任何特定服务器或云厂商运维配置、真实 Secret、真实 API Key、私有设计/开发/测试文档或内部测试报告。

### 两个部署档位

| 档位 | 服务 | 适用场景 |
| --- | --- | --- |
| Core | Web、API、Official Validator | 零模型 Key 的课程学习、建模与验证；AI Teacher 明确关闭 |
| Full | Core + Teacher、auth-db、teacher-db、LiteLLM、litellm-db | 持久化注册、真实 AI、模型管理、对话/Ledger/检索持久化 |

#### Core 快速启动

```bash
docker compose up --build -d
```

访问 <http://localhost:3000>。API 和 Validator 分别位于 `8080` 和 `9090` 端口。

#### Full 完整部署

```bash
cp .env.example .env
# Replace every placeholder in .env with an independently generated value.
npm ci
npm run deploy:full:preflight
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full up --build -d
npm run deploy:full:verify
```

Full 需要真实 Provider Key。默认允许在尚未导入审核知识 Bundle 时使用真实模型，但健康状态会明确标记知识闭环未激活；如需把审核知识作为硬门，将 `AI_TEACHER_REQUIRE_ACTIVE_BUNDLE` 设为 `true`。数据库和 LiteLLM 管理接口默认不映射到公网。变量、初始化顺序、管理员创建、真实模型验收、备份、升级和故障处理见 [DEPLOYMENT.md](DEPLOYMENT.md)。

### 从源代码构建

环境要求：Node.js `24.x`、npm；运行 Compose 时还需要 Docker Engine/Desktop 与 Compose v2。

```bash
npm ci
npm run typecheck:web
npm run build
npm test
npm run test:web
```

下载并校验固定版本的 Official Validator 运行时：

```bash
npm run test:course-official
npm run test:official
```

运行时缓存在 `.official-cache/` 中，不进入 Git。

### 项目结构

```text
apps/
  api/               Platform API and authentication control plane
  teacher/           Real AI Teacher and agent runtime
  validator/         Official SysML v2 validation service
  web/               Learning platform Web application
config/litellm/      Public LiteLLM configuration template
courses/             Public course packs
knowledge-packs/     Public knowledge packs
packages/            Shared runtime contracts and libraries
scripts/             Build, migration, verification, and boundary gates
DEPLOYMENT.md         Core and Full deployment guide
```

### 安全与公开边界

`npm run test:public-boundary` 检查：

- 禁止真实环境文件、私钥、证书和常见 Token 内容进入仓库。
- 禁止特定服务器/云运维路径、内部工作区路径和私有仓库引用。
- 仅允许当前发布契约声明的一个课程包和一个知识包。
- 禁止作者展示页面、作者导航入口和作者头像资源。
- `.env.example` 只能包含变量名和明显占位符；真实 `.env` 被 Git 忽略。

发现安全问题时，请勿在公开 Issue 中粘贴 Token、账号信息、模型数据或漏洞利用细节。

### AI Teacher 单段 Repair Loop

Full 档位使用 Policy v8 驱动单段 Validator Repair Tool Loop。Repair 不再设置应用层输出 Token 硬帽，而是在每个模型步骤前根据上下文窗口动态预留完整 Tool Result 和可见输出空间。默认边界为 3 个 Repair 轮次、256 KiB 候选制品、每个 Run 共享 4 次新知识查询；Validator 调用上限由“初始候选 + Repair 轮次”派生。Policy v8 还为 Main 与 Finalizer 增加显式推理策略，使 GLM 5.3 这类始终思考模型只能在兼容的阶段策略下发布。已有 Policy v6/v7 部署会显式迁移弃用字段并补齐新策略，未知字段或非法旧值继续 fail closed。

运行 `npm run test:teacher-agent-loop` 可验证 Policy v8、v6/v7→v8 迁移、阶段模型/推理协议兼容性、动态上下文预留、共享查询预算、候选提交和 Validator Repair 终止条件。该测试使用可控模型桩验证协议与预算，不代表真实 Provider 验收；真实 AI 验收必须在 Full 镜像中连接 LiteLLM Provider，并将候选模型交给 Official Validator。

### AI Teacher 模型控制平面

Full 档位的模型配置采用 `Provider Connection → Model Deployment → Business Model Alias` 三层边界。协议能力由版本化 Catalog 冻结，Capability Probe 始终通过 LiteLLM 临时模型执行；配置发布只有在 Desired、Applied 与 LiteLLM 实际读回的 Observed 状态一致，并且业务 Alias canary 通过后，才能成为 Active。HTTP 200 本身不代表配置已经生效。

新建的 schema v2 配置默认由 API 动态管理 LiteLLM `model_list`。已有静态部署继续使用 `config/litellm/config.example.yaml`；迁移到动态管理前，应改用 `config/litellm/config.dynamic.example.yaml`（或设置 `LITELLM_CONFIG_PATH`）并重启 LiteLLM。若静态配置仍占有同名 Alias，发布会以 `restart_required` 阻断且不执行写入。

运行 `npm run test:teacher-model-control-plane` 可验证协议 Catalog、配置兼容边界、能力快照、分阶段模型协议、真实 LiteLLM API Reconcile 状态机和 Provider wire contract。该 focused suite 使用受控 HTTP 响应验证协议，不会调用真实 Provider；真实模型仍须按 Full 部署验收执行。

### 开源版与托管服务

| 能力 | 开源 v0.1.0 | 托管体验服务 |
| --- | --- | --- |
| 示例课程/知识包 | 各 1 个 | 以线上实际发布为准 |
| Core | 可本地构建运行 | 已运行 |
| AI Teacher | 仅 Full，必须接入真实 LiteLLM Provider | 按账号权限和线上配置提供 |
| 用户与数据 | Full 使用本地持久化数据库 | 由托管服务管理 |
| 特定生产运维代码 | 不提供 | 由维护者独立管理 |
| SLA | 无 | 体验服务，不承诺 SLA |

托管服务可能包含尚未进入开源版本的功能。公开仓库是开源版本的代码事实来源。

### License

SynFeld 源代码和项目原创内容使用 [Eclipse Public License 2.0](LICENSE)。第三方组件、官方示例和其他资产继续遵循各自许可与声明，详见 [NOTICE](NOTICE)。

---

## English

SynFeld is an open-source learning platform for SysML v2 learners, systems engineers, and MBSE practitioners. It combines guided knowledge, hands-on courses, textual modeling, course rules, the Official Validator, and real AI-assisted teaching in one runnable project.

The current public release is **v0.1.0**. It includes one sample course pack, one sample knowledge pack, and reproducible Core and Full local deployment contracts.

### Hosted experience

**[Open the hosted SynFeld experience](https://www.sysforgeai.com/)**

- The complete experience requires registration with a valid email address that you are legally authorized to use.
- Registration uses email and password without a complex verification flow.
- Guest access is available, but capabilities differ by account and entitlement.
- AI features require registration and the appropriate entitlement.

> The hosted experience is available only through the official HTTPS address. Do not register, enter a password, or upload content if the browser reports an untrusted certificate or insecure connection.

The hosted service is an early experience environment with no SLA. Do not upload confidential, personal, proprietary, or unauthorized engineering data.

### What you can do

1. Read “SysML v2 Engineering Primer and Guide.”
2. Work through “SysML v2 Electric Vehicle Modeling Foundations.”
3. Edit Starter models in the modeling workbench.
4. Run course rules and the Official Validator for traceable diagnostics.
5. Complete the EV final project with structure, satisfaction, and verification relationships.
6. Use the real AI Teacher in Full or the hosted service, then verify its suggestions with deterministic validation and engineering review.

### Core capabilities

- Progressive, editable courses with steps, hints, and rules.
- Browsable knowledge packs.
- A SysML v2 textual modeling workbench.
- Layered validation: course rules followed by the Official SysML v2 Validator.
- AI Teacher is enabled only in Full and must use a real provider through LiteLLM; Core does not start Teacher.
- Chinese and English UI resources and extensible content-package boundaries.

AI suggestions are not final evidence of language or engineering correctness. Use the Official Validator, project rules, and engineering review.

### v0.1.0 contents

| Type | Included content |
| --- | --- |
| Sample course | SysML v2 Electric Vehicle Modeling Foundations `2.2.0`, 32 lessons + 1 final project |
| Sample knowledge pack | SysML v2 Engineering Primer and Guide `1.1.0` |
| Platform | Web, API, Teacher, Validator source and shared contracts |
| Deployment | Core/Full Compose, local databases, LiteLLM, migrations, and acceptance scripts |
| Verification | Public-boundary, deployment, course, API, Teacher, Validator, and Web tests |

The public repository contains no provider secrets, real API keys, server-specific operations, private design/development/test documents, or internal evaluation reports.

### Deployment modes

| Mode | Services | Intended use |
| --- | --- | --- |
| Core | Web, API, Official Validator | Zero-model-key learning, modeling, and validation; AI Teacher is explicitly disabled |
| Full | Core + Teacher, auth-db, teacher-db, LiteLLM, litellm-db | Persistent registration, real AI, model administration, and persistent conversations/Ledger/retrieval |

#### Start Core

```bash
docker compose up --build -d
```

Open <http://localhost:3000>. API and Validator use ports `8080` and `9090`.

#### Start Full

```bash
cp .env.example .env
# Replace every placeholder with an independently generated value.
npm ci
npm run deploy:full:preflight
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full up --build -d
npm run deploy:full:verify
```

Full requires a real provider key. By default, a real model can run before a reviewed knowledge Bundle is imported, while health output explicitly reports that reviewed-knowledge closure is inactive. Set `AI_TEACHER_REQUIRE_ACTIVE_BUNDLE=true` to enforce reviewed knowledge as a hard gate. Databases and the LiteLLM management interface remain internal by default. See [DEPLOYMENT.md](DEPLOYMENT.md) for configuration, initialization, administrator bootstrap, real-model verification, backup, upgrade, and troubleshooting.

### Build and test from source

```bash
npm ci
npm run typecheck:web
npm run build
npm test
npm run test:web
npm run test:course-official
npm run test:official
```

Node.js `24.x` is required. Official Validator artifacts are pinned and hash-verified before use.

### Repository layout

```text
apps/               Web, API, Teacher, and Validator services
config/litellm/     Public LiteLLM template
courses/            Public course packs
knowledge-packs/    Public knowledge packs
packages/           Shared contracts and libraries
scripts/            Build, migration, acceptance, and boundary gates
DEPLOYMENT.md        Core and Full deployment guide
```

### Security and public boundary

Run `npm run test:public-boundary` before every release. The gate rejects real environment files, key material, common token patterns, server-specific operations, private workspace references, private repository references, author-profile UI, and content outside the one-course/one-knowledge-pack v0.1 contract.

`.env.example` contains names and obvious placeholders only. Real `.env` files are ignored by Git. Never paste credentials, model data, or exploit details into a public issue.

### AI Teacher single-stage Repair Loop

The Full profile uses Policy v8 to drive one Validator Repair Tool Loop. Repair no longer applies an application-level output-token cap. Before each model step, it reserves room dynamically for complete tool results and visible output within the context window. Defaults are three Repair rounds, a 256 KiB candidate artifact, and four new reviewed-knowledge queries shared by the run; the Validator ceiling is derived from the initial candidate plus the Repair rounds. Policy v8 also adds explicit Main and Finalizer reasoning policies, so always-thinking models such as GLM 5.3 can only be published with compatible stage policies. Existing Policy v6/v7 deployments use an explicit migration that removes deprecated keys and fills the new policy fields, while unknown keys and invalid legacy values remain fail closed.

Run `npm run test:teacher-agent-loop` to verify Policy v8, v6/v7-to-v8 migration, stage model/reasoning protocol compatibility, dynamic context admission, the shared query budget, candidate submission, and Validator Repair termination. This deterministic suite uses a controllable model double to test the protocol and budgets; it is not real-provider acceptance. Real AI acceptance requires a Full image connected to a LiteLLM provider and an Official Validator check of the generated candidate.

### AI Teacher model control plane

Full uses a three-layer `Provider Connection → Model Deployment → Business Model Alias` boundary. A versioned protocol catalog freezes execution capabilities, Capability Probe calls always pass through a temporary LiteLLM model, and a config becomes Active only after Desired, Applied, and actual Observed runtime state converge and every business-alias canary passes. An HTTP 200 response alone is not evidence that the runtime changed.

Schema v2 configs default to API-owned dynamic LiteLLM `model_list` management. Existing static deployments remain compatible with `config/litellm/config.example.yaml`; switch to `config/litellm/config.dynamic.example.yaml` (or set `LITELLM_CONFIG_PATH`) and restart LiteLLM before enabling dynamic publication. A conflicting static alias produces a fail-closed `restart_required` result with zero writes.

Run `npm run test:teacher-model-control-plane` for the protocol catalog, compatibility boundaries, capability snapshots, per-stage execution profiles, LiteLLM reconciliation state machine, and provider wire contract. The focused suite uses controlled HTTP responses and does not call a real provider; complete the Full acceptance flow for real-model evidence.

The Full rollback-safe LiteLLM template declares both default stage aliases, `ai-teacher-fast` and `ai-teacher-reasoning`. They may share one provider deployment initially; the schema-v2 control plane can publish separate stage deployments after capability probes pass.

### Open source versus hosted service

| Capability | Open-source v0.1.0 | Hosted experience |
| --- | --- | --- |
| Sample content | One course and one knowledge pack | Follows the currently hosted release |
| Core | Locally buildable and runnable | Running |
| AI Teacher | Full only, with a real LiteLLM provider | Controlled by account entitlement and hosted configuration |
| Users and data | Local persistent databases in Full | Managed by the hosted service |
| Production-specific operations | Not included | Maintained separately |
| SLA | None | Early experience, no SLA |

The hosted service may include capabilities not yet present in the public release. The public repository is the source of truth for the open-source version.

### License

SynFeld source code and original project content are licensed under the [Eclipse Public License 2.0](LICENSE). Third-party components, official examples, and other assets retain their respective licenses; see [NOTICE](NOTICE).
