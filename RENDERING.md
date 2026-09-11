# 工程视图渲染

平台将模型语义投影、布局计算与绘图分开。连接的端点、包含上下文与需求引用来自官方对象；布局锚点、避障矩形和坐标不写回 SysML 模型。

| 视图 | 当前能力 | 边界 |
| --- | --- | --- |
| General / 需求 | 多根卡片、成员、类型、继承及支持的 require/assume 引用；中文测量、质量检查 | 不承诺所有专门关系均有自定义投影；未支持情况保留明确原因 |
| Interconnection | 复合容器、端口内外锚点、多根/跨根连接、正交避障 | 不承诺任意图无交叉；不绘制模型未声明的物理流向 |
| Action | 受支持的动作和 succession 正交布局 | 复杂控制流可能采用原生路径 |
| State / Sequence | 官方原生图种、统一皮肤和错误识别 | 不将简单样例外推为全语义覆盖 |
| Browser | 声明成员树、展开折叠及静态列表 SVG | 不沿 typing 重复展开；不是可拖拽的连接拓扑图 |

工作台及 AI 回答使用同一 viewport；BrowserView 随实际能力同步 Teacher 提示。Geometry/Grid 的标准库合法性与渲染支持分别说明。

## 验证

```powershell
npm.cmd ci
npm.cmd run setup:official-validator
npm.cmd run build:teacher-agent
npm.cmd run typecheck:web
npm.cmd test
```

推荐使用已构建的 Validator 容器测试真实字体和 SVG。将 `LAYOUT_VALIDATOR_URL` 和 `BROWSER_VALIDATOR_URL` 设置为该服务实际地址后执行 `npm.cmd run test:diagrams`；不设置时使用本地 Java 和官方缓存。Windows 本地路径可通过 `SYSML_OFFICIAL_JAR`、`SYSML_LIBRARY_PATH`、`GRAPHVIZ_DOT` 配置。

专项验证包括独立声明的端点 oracle、General 44 节点/87 端口/53 边、复杂需求 89 节点/150 边、多根 1～33、错误语法、预算拒绝、几何损坏、Worker 取消与资源恢复。它们证明所测模型与路径，不代替 Chrome 中的可读性和交互验证。原有互连图的 29 条定义级线路与新上下文展开的 162 条关系是不同表示，测试分别保留。

语义依据为固定官方运行时的 StandardViewDefinitions.sysml 及官方解析对象。规范入口：[OMG SysML 2.0](https://www.omg.org/spec/SysML/2.0)，运行时来源：[Pilot 2026-04](https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation/releases/tag/2026-04)。测试夹具是功能回归模型，不作为真实车型或产品设计的工程证据。

## 运行架构影响

共享绘图包取代 Validator 内的重复实现，保留旧 JS 导出作为兼容入口。Teacher 只同步视图能力知识和回答视图转发；没有新增 Worker、LLM Schema、业务状态、候选发布或 Validator 判定。资源策略和 Core/Full 启动契约保持原有边界。
