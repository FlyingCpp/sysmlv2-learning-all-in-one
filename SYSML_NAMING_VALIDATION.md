# Teacher／编辑器命名改进验证记录

日期：2026-09-11。该分支基于绘图提交 `424391f`，仅新增共享保留字知识、命名补全与高亮、可复现的官方语法源及相关验证。

代码与工程验证结果见下表。真实 Provider 探针失败，Chrome 交互未验证，不能宣称完整端到端教学验收通过。未推送、未创建远端 PR。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 依赖安装 | PASS | npm ci，483 包；系统缓存首次 EPERM，改用工作区缓存后完成 |
| 官方词表与来源 | PASS | 五份源文件与固定内核归档逐字节一致；129 个词条、两个生成资产一致；check:sysml-keywords |
| 完整回归 | PASS | npm test 退出 0，含原有公开门、完整绘图专项和新增词表测试；.tmp/full-first.log |
| 公开边界与差异检查 | PASS | verify-public-boundary.js、git diff --check |
| Teacher 编译与提示词 | PASS | 共享提示 1,825 字节；Candidate/Repair 接入；实际镜像模块加载及编译产物检查 |
| 官方命名验证 | PASS | 全部 129 个限定名称和限定引用通过；frame/references/first 三组未限定反例按预期失败；无 fallback；.tmp/keywords-official.log |
| Web 专项 | PASS | test:web 全部通过，含 i18n、phase0～4、类型检查和生产构建；.tmp/web-first.log |
| 编辑器边界 | PASS | 普通名称与大小写、已有／未闭合限定名称、注释、字符串、转义引号、跨行注释恢复、def/in/out/inout/all 短语；phase3 |
| 镜像构建 | PASS | Teacher 384662b、Web 3f3c979，公开 Dockerfile 构建退出 0 |
| 真实 Validator Tool | PASS | 既有栈六项 Token 布尔门通过；HTTP 200、syntax/semantic=true、fallback=false、workspaceHash 存在；.tmp/runtime-gate.log |
| 真实 Provider | BLOCK | 既有 verify-real-provider.js 探针返回 LiteLLM HTTP 500；模型列表接口 200 且探针别名存在；.tmp/provider-probe.log、.tmp/runtime-assets.log。尚无真实模型成功输出证据，未据此推断故障根因 |
| Chrome 交互 | UNVERIFIED | 浏览器控制的请求头策略／Statsig 故障，未能操作页面；接口、源码及 Web 构建通过不替代真实交互验收 |

首次失败日志保留在本地忽略的 .tmp 中。语法源首次比对发现工作区换行转换造成字节不同；改从固定内核直接提取，并通过 .gitattributes 保留原始字节，避免跨平台哈希漂移。上游语法原有的行末空白与 CRLF 导致首次暂存差异检查失败；仅这五份未经修改的第三方文件免于空白规范检查，保留来源哈希，项目代码继续检查。

本地测试栈沿用原配置、网络与数据，只替换 Teacher/Web 镜像；停用的上一版容器仍保留用于回退。API/Validator 继续运行前一个绘图改动镜像。凭据不进入源码、报告或日志。

待补验收：恢复 Provider 后验证真实 Candidate/Repair 命名行为及用户可见答案；恢复 Chrome 后验证补全菜单／Tab 插入、块注释高亮、中文名称与撤销行为。两项缺口均不能用模拟模型结果代替。
