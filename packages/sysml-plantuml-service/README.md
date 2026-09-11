# SysML v2 共享绘图服务

此包与 Validator 同进程部署。`SysmlPlantUmlService.render(input)` 接收工作区文件及视图名称，返回 SVG、模型投影、布局质量及来源信息；不会修改输入模型。

绘图链路：官方 SysML 对象 → DiagramDocument → ELK → 有界避障与几何检查 → PlantUML UGraphic/ImageBuilder → SVG。General、受支持的需求关系、Interconnection 和简单 Action 使用本地布局；State/Sequence 和尚未覆盖的语义保留有原因的原生路径。BrowserView 返回 `browserTree` 与静态成员列表 SVG。

`source.js` 管理输入和临时视图；Java 投影器管理模型身份与关系；`diagram-layout.js`、`general-layout.js` 和 `orthogonal-router.js` 管理几何；Java scene renderer 使用固定版本的 PlantUML 绘图 API。调用方仍须检查 `ok`、diagnostics 及投影完整性，不能把非空 SVG 当作全部关系正确。

本地布局最多 200 节点、1200 端口、800 边；每个 Worker 的 V8 老生代堆上限为 256 MB，每个服务进程最多两个布局 Worker 并发，布局/避障/检查共享最多 10 秒。这不是整个进程的总内存上限或整个请求的时限。布局失败明确返回错误，不通过删除图元或增大超时冒充成功。Browser 成员树有独立的 1000 元素预算，根深度为 0、最大深度为 32。

显式 `layoutOptimization: { mode: 'off' }` 保留原生绘图路径；该路径的资源范围不同。大图仍可能需要缩放、平移；当前没有拓扑折叠、根分页、固定节点、增量重排或零交叉保证。Browser 的展开折叠只适用于成员树。

依赖：ELK.js 0.11.1（EPL-2.0）；官方 Pilot 2026-04 / kernel 0.59.0 和其随附 PlantUML；Java 21、Graphviz、Noto Sans CJK SC。独立消费者先执行 `npm ci --prefix packages/sysml-plantuml-service`，再提供 jarPath、libraryPath、classesPath、dotPath。平台 Dockerfile 自动安装依赖并验证官方构件哈希。

完整开发与验收命令见根目录 [RENDERING.md](../../RENDERING.md)。

## 维护入口

| 文件 | 职责 |
| --- | --- |
| `service.js` / `official-plantuml-backend.js` | 调度选定 view、默认增强或显式原生路径、官方运行时调用 |
| `official/src/org/sysmlv2/learning/validator/` | 从官方对象投影成员、端口、需求关系，并完成原生／场景绘制 |
| `diagram-layout.js` / `diagram-layout-worker.js` | ELK 计算、并发及预算、取消与几何检查 |
| `general-layout.js` / `orthogonal-router.js` | 结构／需求卡片几何与有界正交避障 |
| `plantuml-layout-optimizer.js` | 协调投影、布局及绘制，返回能力路径、质量和错误信息 |

增强路径返回 `layoutScene`、`geometryQuality`、`geometryHash` 和 `layoutVersion`，便于检查具体几何结果；Browser 返回 `browserTree`。这些字段分别描述展示结构及计算结果，不能替代官方模型校验或工程评审。改变布局规则时，应同时复核端点、归属、图元数量和异常路径，而不仅比较截图是否更美观。
