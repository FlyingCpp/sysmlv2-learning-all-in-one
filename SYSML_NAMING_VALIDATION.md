# Teacher／编辑器命名改进验证记录

日期：2026-09-11。该分支基于绘图提交 `424391f`，新增共享保留字知识、命名补全与高亮、可复现的官方语法源，以及交互复测发现的 Teacher 最终回答视图能力说明修正。

代码与工程验证结果见下表，保留首次失败。随后应用内浏览器已完成主要交互和两轮真实 Teacher 可见回答验证；修正能力说明后的真实 AI 复测被平台周 token 配额拦截，因此不能宣称全部验收通过。Chrome 扩展连接仍未恢复。未推送、未创建远端 PR。

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

首次待补项为真实 Teacher 命名行为和浏览器交互。后续进展见以下复测记录；首次 HTTP 500 不再代表当前所有真实模型调用均失败。

## 当日浏览器复测

入口为 `http://localhost:13000/#/bench`，API 为 `18081`，Validator 为 `19090`。Chrome 控制仍在请求头策略加载阶段失败；本次通过 Codex 应用内浏览器访问同一测试栈，使用页面提供的游客入口。应用内浏览器没有复用用户的 Chrome 登录态，因此这些证据不覆盖其已登录账户或 Chrome 扩展链路。

| 交互 | 结果 | 页面证据 |
| --- | --- | --- |
| 保留字补全 | PASS | `part frame` 的菜单显示限定名称建议，Enter 和 Tab 均得到 `part 'frame'`；撤销恢复原文 |
| 编辑器保护边界 | PASS | 行／块注释、字符串、未闭合限定名称、`part def` 和 `part Frame` 不被错误添加引号 |
| 实际高亮 | PASS | 跨行块注释三行同为注释颜色，结束后 package/part 恢复关键字颜色；限定名称不被错误着色为 frame 关键字 |
| GeneralView | PASS | 中文车辆系统及 frame/battery 子成员、Controller 独立根完整显示；适应、100%→120% 缩放、全屏和关闭可操作 |
| BrowserView | PASS | 四元素成员树，全部折叠隐藏子成员、展开恢复；全屏内操作生效，Esc 关闭；没有图形缩放按钮 |
| 视口与中文 | PASS（限定范围） | 宽屏及窄屏截图均已观察，测得文档没有横向溢出；窄屏类型英文标签存在换行，不据此宣称全面移动端体验验收 |
| 无效模型反馈 | PASS | 未限定 frame 触发官方诊断；旧图被移除，不保留成功展示 |
| 真实 Teacher 第 1 轮 | 交付 PASS，内容有偏差 | 59 秒后显示完整命名解释，发送入口恢复；“普通名称不应加引号”把风格建议说得过强 |
| 真实 Teacher 第 2 轮 | 交付／候选 PASS，能力说明有缺陷 | 70 秒后显示完整回答和官方验证通过候选，保留包名 Broken 与名称 frame；主动区分普通名称加引号的语法合法性与风格建议 |
| 回答候选预览和应用 | PASS | 代码预览渲染为 Browser 成员树；复制代码块后手动填入编辑器，重新生成显示“已自动保存并通过校验”和 Broken::brokenBrowser 的 frame 成员 |
| 修正后真实 Teacher 第 3 轮 | BLOCK | 页面提示“本周 AI Teacher tokens 已用完，下周重置后可继续使用。”并显示本轮未生成可见内容；发送入口恢复，但没有新答案，不能算修正后的真实模型通过 |

第 2 轮候选为：

```sysml
package Broken {
  part 'frame';

  view brokenBrowser : StandardViewDefinitions::BrowserView {
    expose 'frame';
  }
}
```

第 2 轮最终说明仍将 BrowserView 描述为缺少专用图形模式，遗漏已可用的成员树。根因是 Finalizer 的能力投影仅按五种 PlantUML 图形模式分类，BrowserView 被放入未支持集合。现将成员浏览能力从该集合分离，保留工作台、回答预览的展开／折叠能力说明；GeometryView、GridView 的专用渲染未支持边界继续保留。提示词版本升为 `final-answer-worker-v17-membership-capability`。

修正后 Teacher 编译通过，22 组 Teacher 运行管理测试全部通过，新增专项覆盖问题指定／候选产生 BrowserView、中文别名、混合未支持视图、确定性回退和无关问题。日志为 `.tmp/ui-retest-teacher-build.log`、`.tmp/ui-retest-teacher-regression.log`。新 Teacher 镜像 `synfeld-teacher:keywords-ui` 已接入原测试栈，镜像构建退出 0；六项 Token 布尔门和真实 Validator Tool 再次通过（HTTP 200、语法／语义通过、无 fallback），见 `.tmp/ui-retest-teacher-image.log`、`.tmp/ui-retest-runtime-gate.log`。公开边界、129 词条一致性和差异检查通过。

当前剩余验收是周配额可用后的修正版本真实能力问答，以及 Chrome 扩展链路本身。没有调整配额或切换身份绕过限制；前两轮真实交付、自动回归和实际成员树展示均不能替代修正后的真实模型答案。

## README 资源树展示前的能力核对

2026-09-11，核对公开 main `f68b95e` 的 `WorkbenchPage.tsx`、`SysmlCodeMirror.tsx` 与 `MuiModelOutlineTree.tsx`，并在既有本地应用内浏览器测试会话执行两项验证：向 Broken 包新增 `part navProbe;` 后，资源树自动出现 navProbe 且显示“已与当前代码同步”；点击 navProbe 节点后，编辑器出现 `cm-navigationHighlight`，高亮内容为 navProbe。验证后恢复原模型，没有发起新的 AI 提问。

确认范围是树节点定位代码、代码修改后自动刷新官方语义树。源码定位需要节点具有可用的位置信息，语义树刷新需要成功解析；当前没有将编辑器光标绑定到树的受控选择／展开状态，因此 README 不声称光标移动会自动选中并展开对应树节点，也不声称可以在树中直接编辑模型。
