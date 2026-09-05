# SynFeld Deployment Guide / SynFeld 部署指南

[中文](#中文部署指南) · [English](#english-deployment-guide)

## 中文部署指南

### 1. 部署契约

SynFeld 提供两个明确的本地运行档位。Core 不启动 AI Teacher；只有连接真实模型网关的 Full 档位才启用 AI Teacher。

| 档位 | 服务 | 数据特征 | 用途 |
| --- | --- | --- | --- |
| Core | Web、API、Official Validator | 学习草稿与进度使用 Docker 卷；账号会话为临时内存状态 | 零模型 Key 的课程学习、建模和验证 |
| Full | Core + Teacher、auth-db、teacher-db、LiteLLM、litellm-db | 账号、Teacher 对话/Ledger/检索、LiteLLM 状态和学习数据持久化 | 注册、真实 AI、模型管理和完整本地运行 |

Full 中的三个数据库是不同数据域：

- `auth-db`：账号、会话、权限和管理审计。
- `teacher-db`：AI Teacher 对话、运行 Ledger、知识检索和向量数据。
- `litellm-db`：LiteLLM 配置、路由和用量状态。

不要为了简化而让三个服务共享同一个数据库用户或全部权限。

### 2. 版本矩阵

| 组件 | 固定版本 |
| --- | --- |
| Node.js 构建基础镜像 | `24.12.0-alpine`，Dockerfile 中固定 digest |
| PostgreSQL（auth-db、litellm-db） | `16.11`，Compose 中固定 digest |
| PostgreSQL + pgvector（teacher-db） | PostgreSQL `16.14` / `pg16`，Compose 中固定 digest |
| LiteLLM | `1.90.0`，Compose 中固定 digest |
| SysML v2 Pilot Validator | Release `2026-04`、Kernel `0.59.0`，构建时校验固定哈希 |

镜像升级必须先备份数据，再更新版本和 digest，并重新执行迁移与完整验收。不能只修改标签而保留旧 digest。

### 3. 前置条件

- Docker Engine 29+ 或当前受支持的 Docker Desktop。
- Docker Compose v2.40+。
- 建议至少 4 CPU、12 GB 可用内存和 15 GB 磁盘空间；Validator 与 LiteLLM 启动时资源占用较高。
- 从源码执行测试时需要 Node.js 24.x 和 npm。
- Full 档位需要一个兼容 LiteLLM 的真实模型 Provider 账号和合法 API Key。

检查版本：

```bash
docker version
docker compose version
node --version
npm --version
```

### 4. Core：零 Key 学习与验证

Core 不启动 Teacher，也不需要模型 API Key：

```bash
docker compose up --build -d
docker compose ps
```

访问：

- Web：<http://localhost:3000>
- API：<http://localhost:8080>
- Validator：<http://localhost:9090>

健康检查：

```bash
curl http://localhost:8080/health
curl http://localhost:9090/health
```

Core 的 Web 和 API 都显式关闭 AI Teacher。`api_data` 卷会保存学习草稿和进度，但 Core 的认证适配器运行在临时内存模式；需要持久化注册和会话时使用 Full。

停止 Core：

```bash
docker compose down
```

### 5. Full：数据库、LiteLLM 与真实 AI

#### 5.1 创建本地环境文件

复制模板：

```bash
cp .env.example .env
```

PowerShell：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，替换所有 `replace-with-...` 占位符。每个数据库密码、服务 Token、LiteLLM Master Key、Salt Key 和 Provider Key 必须不同。建议使用密码管理器或本机随机数工具生成至少 32 字符的随机值。

`AI_TEACHER_REQUIRE_ACTIVE_BUNDLE=false` 是公开版默认策略：真实 Provider、Teacher 数据库和 Agent Runtime 可先运行，但 `/health` 会明确报告审核知识尚未激活。若部署方已准备经过许可与审查的 SysML 知识 Bundle，并要求所有回答必须绑定该证据，将该变量设为 `true`；此时 Bundle 未激活会使 Teacher 保持未就绪。

公开仓只提供变量名和占位符；不要把 `.env`、真实 Key、数据库连接串或运行日志提交到 Git。

#### 5.2 环境预检

```bash
npm ci
npm run deploy:full:preflight
```

预检会验证：

- 所有必填值存在且不再是占位符；
- 关键服务 Token 至少 32 字符；
- 数据库密码、内部 Token、Tool Token、Master Key、Salt Key 和 Provider Key 彼此不同；
- Provider API Base 使用 HTTPS。

预检只输出布尔状态和错误字段名，不输出敏感值。

#### 5.3 启动 Full

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.full.yml \
  --profile full \
  up --build -d
```

PowerShell：

```powershell
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full up --build -d
```

启动顺序由健康条件约束：

```text
auth-db ────────────────> auth schema migration ─> API
teacher-db ─────────────> teacher schema migration ─> Teacher
litellm-db ─> LiteLLM ───────────────────────────────> Teacher
Validator ───────────────────────────────────────────> API
API ─────────────────────────────────────────────────> Web
```

API 和 Teacher 容器会在各自服务启动前执行幂等迁移。数据库第一次初始化可能需要数十秒。

#### 5.4 配置 LiteLLM

公开模板位于 `config/litellm/config.example.yaml`，采用三个不同的业务域：

```text
Provider Connection
→ Model Deployment
→ Business Model Alias
```

- Provider Connection：`PROVIDER_API_BASE` 和 `PROVIDER_API_KEY`，只进入 LiteLLM 服务端。
- Model Deployment：`PROVIDER_MODEL` 对应的真实 Provider 模型及 RPM/TPM 限制。
- Business Model Alias：平台使用的稳定名称，默认是 `ai-teacher-fast`。

同一个 Alias 可以在配置中包含多个 Deployment，用于路由或故障转移；不要把删除的 Alias 自动映射到另一个 Alias。修改 Alias 后，还需要同步检查平台 Agent 资源策略中的引用。

schema v2 管理配置默认使用动态运行时所有权。首次迁移时：

1. 保留当前 `config/litellm/config.example.yaml` 作为可回滚的静态配置。
2. 将 `LITELLM_CONFIG_PATH` 设为 `./config/litellm/config.dynamic.example.yaml`。
3. 重启 LiteLLM，确认静态 `model_list` 已退出。
4. 在管理界面完成 Connection、Deployment、Alias 和 Capability Probe，再发布配置。

发布不是一次“写配置成功”请求。API 会验证 Agent Policy 引用闭包，经 LiteLLM 原生模型管理 API 应用 Desired 状态，再读取 `/model/info`、`/v1/models` 和 `/router/settings` 比对 Observed 状态，并执行业务 Alias canary。任一环节不一致都会阻止版本成为 Active；静态同名 Alias 冲突会返回 `restart_required` 且不写入运行时。

LiteLLM 管理端口不映射到宿主机，也不应直接暴露到公网。平台通过容器网络访问它。

#### 5.5 部署验收

检查容器和公开端点：

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full ps
npm run deploy:full:verify
```

然后执行一次真实、会产生少量模型费用的 Provider 调用：

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.full.yml \
  --profile full \
  run --rm --no-deps teacher \
  node scripts/verify-real-provider.js
```

PowerShell 可将上面的命令写成一行。脚本只输出模型调用是否成功、模型名和用量是否存在，不输出 Provider Key 或完整模型回答。

最后在浏览器完成：

1. 注册一个普通用户并重新登录。
2. 打开课程并保存草稿。
3. 执行 Official Validator，确认返回正式 Validator 结果。
4. 使用 AI Teacher 发起一次真实问题，确认不是占位响应。
5. 重启容器，再次登录并确认账号、草稿和对话仍存在。

Teacher `/health` 中的 `provider`、`retrieval` 和 `knowledgePolicy` 分别表明真实网关、持久化检索后端与审核知识策略。若 `activeBundle` 为空，表示尚未激活经过审查的 SysML 知识 Bundle；此时真实模型连接可以工作，但不能把回答宣称为经过内部知识证据闭环。将 `AI_TEACHER_REQUIRE_ACTIVE_BUNDLE=true` 后，该状态会直接阻断 Teacher 就绪。生产级知识增强需要另行导入并激活经过许可与审查的 Bundle。

### 6. 创建首个管理员

先通过 Web 正常注册目标邮箱，然后在 API 容器中执行带确认参数的初始化：

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.full.yml \
  --profile full \
  run --rm --no-deps api \
  node scripts/auth-bootstrap-admin.js \
  --email owner@example.com \
  --verify-email \
  --apply \
  --confirm-email owner@example.com
```

该命令要求重复确认目标邮箱，并写入审计事件。不要通过直接修改数据库绕过初始化脚本。

### 7. 配置变量

| 变量 | 所有者 | 说明 |
| --- | --- | --- |
| `AUTH_DB_PASSWORD` | auth-db | 认证数据库密码 |
| `TEACHER_DB_PASSWORD` | teacher-db | Teacher 数据库密码 |
| `LITELLM_DB_PASSWORD` | litellm-db | LiteLLM 数据库密码 |
| `BETTER_AUTH_SECRET` | API | 会话签名 Secret，轮换会使现有会话失效 |
| `AI_TEACHER_INTERNAL_TOKEN` | API、Teacher | 服务间请求认证 |
| `AI_TEACHER_TOOL_TOKEN` | API、Teacher | Validator Tool 请求认证；必须不同于 Internal Token |
| `LITELLM_MASTER_KEY` | API、Teacher、LiteLLM | LiteLLM 管理和网关认证 |
| `LITELLM_SALT_KEY` | LiteLLM | 稳定加密 Salt，迁移时必须保留 |
| `LITELLM_CONFIG_PATH` | LiteLLM | 静态/动态运行时所有权配置文件；迁移前保持默认静态模板 |
| `PROVIDER_API_BASE` | LiteLLM | Provider HTTPS 入口 |
| `PROVIDER_API_KEY` | LiteLLM | Provider Key，不得进入 Web、API 响应或日志 |
| `PROVIDER_MODEL` | LiteLLM | 真实 Model Deployment 名称 |
| `AI_TEACHER_MODEL` | Teacher | 稳定 Business Model Alias |
| `AI_TEACHER_REQUIRE_ACTIVE_BUNDLE` | API、Teacher | `false` 允许真实模型在无审核 Bundle 时运行；`true` 将审核知识设为就绪硬门 |

### 8. 安全边界

- 数据库和 LiteLLM 管理端口默认只在 Compose 网络内可见。
- Web、API、Teacher 和 Validator 默认只绑定宿主机 `127.0.0.1`。
- 对外部署必须增加可信域名、TLS、反向代理、网络访问控制和备份监控。
- Provider Key 只进入 LiteLLM；不得写入 Web 配置、课程包、日志、错误响应或测试快照。
- `.env` 已被 Git 忽略；提交前仍应运行 `npm run test:public-boundary`。
- 不要在 Issue、聊天记录或截图中粘贴 Key、连接串和完整 Provider Trace。
- LiteLLM 日志模板关闭请求/响应正文记录；启用额外日志前先验证脱敏行为。

### 9. 备份、恢复与升级

Full 使用四个命名卷：`api_data`、`auth_db_data`、`teacher_db_data` 和 `litellm_db_data`。升级前至少备份三个数据库，并单独保存 `.env` 中的 Salt 与密钥到受控密码管理系统。

示例备份流程：

```bash
mkdir -p backups
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full exec -T auth-db sh -c 'pg_dump -U synfeld_auth -d synfeld_auth -Fc -f /tmp/auth.dump'
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full cp auth-db:/tmp/auth.dump backups/auth.dump
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full exec -T teacher-db sh -c 'pg_dump -U synfeld_teacher -d synfeld_teacher -Fc -f /tmp/teacher.dump'
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full cp teacher-db:/tmp/teacher.dump backups/teacher.dump
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full exec -T litellm-db sh -c 'pg_dump -U litellm -d litellm -Fc -f /tmp/litellm.dump'
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full cp litellm-db:/tmp/litellm.dump backups/litellm.dump
```

恢复会覆盖或合并现有数据，必须先停止写入、确认目标数据库并在独立环境演练。升级顺序：备份 → 更新镜像版本与 digest → 启动数据库 → 执行迁移 → 启动服务 → 完整验收 → 保留回滚镜像和备份。

### 10. 常见故障

| 现象 | 原因与处理 |
| --- | --- |
| Full 预检 BLOCK | `.env` 缺失、仍有占位符、值过短、Key 重复或 Provider URL 不是 HTTPS |
| API 反复重启 | `auth-db` 未健康、认证迁移失败或 `BETTER_AUTH_SECRET` 缺失 |
| Teacher 反复重启 | `teacher-db`、LiteLLM 未健康，Token 不一致，或数据库迁移失败 |
| LiteLLM 不健康 | 数据库连接失败、Master/Salt Key 缺失或 YAML 配置错误 |
| Provider 验证返回 401/403 | Provider Key 无效或模型账号无权限；不要把 Key 打印到日志 |
| Provider 验证返回 404 | `PROVIDER_MODEL`、API Base 或 LiteLLM Adapter 前缀错误 |
| Teacher `activeBundle` 为空 | 数据库已就绪但没有激活审查后的知识 Bundle；不能声明知识闭环就绪 |
| 端口被占用 | 在 `.env` 中调整 `WEB_PORT`、`API_PORT`、`TEACHER_PORT`、`VALIDATOR_PORT` |

查看脱敏日志：

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full logs --tail 200 api teacher litellm
```

停止 Full 但保留数据：

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full down
```

`down -v` 会删除本地卷和全部持久化数据，只能在已经确认备份且确实需要重建时执行。

---

## English deployment guide

### 1. Deployment contract

SynFeld provides two explicit local operating modes. Core does not start AI Teacher. AI Teacher is enabled only in Full, where a real model provider is connected through LiteLLM.

| Mode | Services | Data behavior | Intended use |
| --- | --- | --- | --- |
| Core | Web, API, Official Validator | Learner drafts and progress use a Docker volume; account sessions are temporary in-memory state | Zero-key learning, modeling, and validation |
| Full | Core + Teacher, auth-db, teacher-db, LiteLLM, litellm-db | Persistent accounts, Teacher conversations/Ledger/retrieval, LiteLLM state, and learner data | Registration, real AI, model administration, and complete local operation |

The three databases are separate data domains. Do not share one database role with unrestricted access across them.

### 2. Pinned versions

| Component | Pinned version |
| --- | --- |
| Node.js build image | `24.12.0-alpine`, pinned by digest in Dockerfiles |
| PostgreSQL for auth-db and litellm-db | `16.11`, pinned by digest |
| PostgreSQL + pgvector for teacher-db | PostgreSQL `16.14` / `pg16`, pinned by digest |
| LiteLLM | `1.90.0`, pinned by digest |
| SysML v2 Pilot Validator | Release `2026-04`, Kernel `0.59.0`, downloaded with fixed hash verification |

Back up all data before changing an image version or digest. Re-run migrations and the complete acceptance flow after every upgrade.

### 3. Prerequisites

- Docker Engine 29+ or a currently supported Docker Desktop release.
- Docker Compose v2.40+.
- Recommended minimum: 4 CPUs, 12 GB available memory, and 15 GB free disk space.
- Node.js 24.x and npm when running source tests.
- A legitimate API key for a real LiteLLM-compatible model provider for Full.

### 4. Start Core

```bash
docker compose up --build -d
docker compose ps
```

Open <http://localhost:3000>. API and Validator are available on ports `8080` and `9090`. Core explicitly disables AI Teacher in both Web and API configuration.

Stop Core without deleting volumes:

```bash
docker compose down
```

### 5. Start Full

Copy `.env.example` to `.env`, replace every placeholder with an independently generated value, and run:

```bash
npm ci
npm run deploy:full:preflight
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full up --build -d
```

The API and Teacher run idempotent schema migrations before starting. Health-based dependencies ensure that databases, LiteLLM, Validator, API, and Web start in the required order.

`AI_TEACHER_REQUIRE_ACTIVE_BUNDLE=false` is the public default. It lets the real provider, persistent Teacher storage, and Agent Runtime operate before a reviewed knowledge Bundle is imported, while `/health` explicitly reports that reviewed knowledge is inactive. Set it to `true` only when a licensed and reviewed Bundle has been prepared and every answer must be evidence-bound; without an active Bundle, Teacher will then remain unready.

Verify infrastructure and public endpoints:

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full ps
npm run deploy:full:verify
```

Run one real provider completion, which may incur a small provider charge:

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full run --rm --no-deps teacher node scripts/verify-real-provider.js
```

The verifier never prints keys or the full model answer.

### 6. LiteLLM object model

The public template at `config/litellm/config.example.yaml` keeps these domains separate:

```text
Provider Connection
→ Model Deployment
→ Business Model Alias
```

`PROVIDER_API_BASE` and `PROVIDER_API_KEY` define the connection. `PROVIDER_MODEL` identifies the concrete deployment. `AI_TEACHER_MODEL`, defaulting to `ai-teacher-fast`, is the stable business alias used by SynFeld. Never silently remap a deleted alias to a different alias.

The rollback-safe static template exposes both `ai-teacher-fast` and `ai-teacher-reasoning`, because the default Agent Policy uses the latter for Candidate and Repair. In a single-provider installation both aliases intentionally reuse `PROVIDER_MODEL`; publish a schema-v2 dynamic control-plane configuration when the stages should use different deployments.

The LiteLLM management port is not published to the host. SynFeld reaches it only through the Compose network.

Schema v2 administration uses dynamic runtime ownership by default. Keep `config/litellm/config.example.yaml` as the rollback-safe static configuration, set `LITELLM_CONFIG_PATH=./config/litellm/config.dynamic.example.yaml`, restart LiteLLM, and verify that the static `model_list` has been removed before publishing from the administration UI.

Publication validates Agent Policy reference closure, applies Desired state through LiteLLM's native model-management APIs, reads back `/model/info`, `/v1/models`, and `/router/settings`, and runs business-alias canaries. The version becomes Active only after Observed state converges. A conflicting static alias returns `restart_required` with zero runtime writes.

### 7. Bootstrap the first administrator

Register the target email through Web first, then run the guarded bootstrap command:

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full run --rm --no-deps api node scripts/auth-bootstrap-admin.js --email owner@example.com --verify-email --apply --confirm-email owner@example.com
```

The repeated confirmation is mandatory and an audit event is recorded.

### 8. Security boundaries

- Databases and the LiteLLM administration interface remain internal to the Compose network.
- Public service ports bind to `127.0.0.1` by default.
- External deployments require a trusted domain, TLS, a reverse proxy, network access controls, backups, and monitoring.
- Provider keys must exist only in server-side configuration and must never enter Web configuration, API responses, logs, screenshots, or test snapshots.
- `.env` is ignored by Git. Still run `npm run test:public-boundary` before every release.
- The template disables LiteLLM message-body logging. Verify redaction before enabling additional logs.

### 9. Readiness, backup, and upgrades

`npm run deploy:full:verify` checks Web, API, persistent authentication, Teacher-to-LiteLLM wiring, PostgreSQL/pgvector retrieval, and the Official Validator. The separate provider verifier proves a real completion.

Teacher `/health` reports `provider`, `retrieval`, and `knowledgePolicy` independently. An empty `activeBundle` means no reviewed SysML knowledge Bundle has been activated. The real provider can still answer under the public default, but the deployment must not claim reviewed-knowledge closure until a licensed and reviewed Bundle is imported and activated. With `AI_TEACHER_REQUIRE_ACTIVE_BUNDLE=true`, the same condition is a readiness blocker.

Full uses four named volumes: `api_data`, `auth_db_data`, `teacher_db_data`, and `litellm_db_data`. Back up the three PostgreSQL databases and preserve the stable Salt and keys in a controlled password manager before upgrades. Restore operations are destructive and must be rehearsed in an isolated environment.

### 10. Troubleshooting

| Symptom | Action |
| --- | --- |
| Preflight returns BLOCK | Replace placeholders, use distinct values, lengthen service tokens, and use an HTTPS provider endpoint |
| API restarts | Check auth-db health, auth migration, and Better Auth configuration |
| Teacher restarts | Check teacher-db, LiteLLM, service-token consistency, and migration logs |
| LiteLLM is unhealthy | Check its database, Master/Salt keys, and YAML syntax |
| Provider returns 401/403 | Verify account permission and the provider key without printing it |
| Provider returns 404 | Verify the API base, adapter prefix, concrete model, and business alias |
| `activeBundle` is empty | Storage is ready, but reviewed knowledge has not been activated |

Stop Full while preserving data:

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile full down
```

Do not run `down -v` unless deletion of all local persistent data is intentional and verified backups exist.
# AI Teacher 管理能力升级说明

Full 部署中 API、Teacher、Validator 必须共享同一非空 `AI_TEACHER_INTERNAL_TOKEN`；
API 与 Teacher 另外共享不同的 `AI_TEACHER_TOOL_TOKEN`。不要将凭据写入版本控制。
管理页发布资源策略时先应用并回读各 Owner，再保存 Active；失败会尝试恢复上一版本。
升级后核对管理页 `inSync` 与各 Owner 状态，不能只看健康检查。

Conversation Store 初始化会增加任务生命周期与事件表，保留已有会话和 Run。
升级前备份持久化数据库；本次代码回退不会自动删除新增表或回滚已有策略数据。
账户额度改为对话开始时准入、实际消耗结算，单轮可能超过剩余余额，下一轮在余额为零时拒绝。
`AI_TEACHER_REQUIRE_ACTIVE_BUNDLE=false` 的公开 Full 契约继续保留。
