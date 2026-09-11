# 绘图迁移验证记录

日期：2026-09-11。基线：PR #5 的 d620aac。范围为共享图形服务、Validator 接入、BrowserView UI/能力提示和必要的测试契约更新。

代码与工程检查通过，真实 Chrome 交互验收 **UNVERIFIED**，因此不宣称全部用户体验验收完成。未推送、未创建远端 PR。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 公开依赖安装 | PASS | npm ci；首次 offline 缺少 undici 缓存，正常安装完成 483 包 |
| 公开边界 | PASS | node scripts/verify-public-boundary.js |
| Teacher 编译与 Web 类型检查 | PASS | build:teacher-agent、typecheck:web |
| 完整回归 | PASS | npm test，包含全部原有公开门及 test:diagrams；.tmp/full-final.log，退出 0 |
| Web 专项 | PASS | test:web 的 i18n、phase0～3 通过；phase4 修正旧断言后单独退出 0，.tmp/web-phase4-verified.log |
| 图形专项 | PASS | test:diagrams；官方模式、工程视图、Browser、多根、General、复杂需求、关系及路由器 |
| 服务与 CJK 字体 | PASS | test:plantuml-runtime；4 条中文标签，最小每字 1.000em |
| 容器构建 | PASS | 公开 Validator/API/Teacher/Web Dockerfile 均构建；Validator Linux Java 构件哈希门通过 |
| 真实 Validator Tool | PASS | 既有本地测试栈：六项 Token present/match/distinct 布尔门；Tool 200、syntax/semantic=true、fallback=false、候选工作区 hash 存在；.tmp/runtime-gate.json |
| Chrome | UNVERIFIED | 三次控制失败：Unable to load browser request-header policy / Timed out waiting for Statsig values；没有以接口或源码测试代替浏览器交互通过 |

图形服务在既有测试栈的 19090，API 18081，Web 13000；复用原容器配置与数据，并保留停用的原容器用于回退，没有创建第二套测试栈。凭据未写入源码、报告或日志。

模型证据：Browser 177 元素；General 44 节点/87 端口/53 边；复杂多根互连 79/235/162；需求图 89 节点/150 边，保留 h82 有界避障；28 个多根与预算用例全部通过。测试逐条核对声明端点并注入几何损坏，不只检查返回状态。

首次失败保留：.tmp/full-first.log 的 Teacher 摘要预算断言；修正测试覆盖 24k 摘要和 20k 安全省略，生产压缩器未改。旧 Web phase4 断言仍要求 380 宽度、硬编码中文、running 单一状态和固定复制标签；基线已使用最大宽度、翻译键、submission 状态及复制结果，更新测试与这些现有行为一致，未改对应 UI 行为。接口旧 source/连接计数断言已分别迁移到语义布局和原生兼容检查，保留首次日志。

Windows javac 曾在退出时报告 ZipFS AccessDeniedException，类文件生成且命令退出 0；Linux 容器编译与哈希门另行通过。该本机诊断不能当作容器失败，也不隐去。

后续需在 Chrome 可用时完成 Browser 展开/折叠、工作台/回答图切换、全屏、长中英文错误、移动/1080p/2K 阅读和取消加载检查。该缺口不影响已完成的服务端证据，但阻止完整 UI 验收结论。
