import { createRequire } from "node:module";

// 与既有 Candidate Contract 一致，从编译后的 dist/agent 解析共享资产。
const asset = createRequire(import.meta.url)("../../../../packages/teacher-contract/sysml-reserved-keywords.json") as {
  baseline: string;
  keywords: string[];
};

export const SYSML_RESERVED_KEYWORD_GUIDANCE = `SysML v2 必备命名知识（${asset.baseline}）：
- 以下保留字区分大小写，不可直接用作普通标识符；用作声明名称或名称引用时，使用单引号限定名称，或在不改变用户意图的前提下选用非保留名称。
- 例如 part def Frame; part 'frame' : Frame;；引用同一名称也写成 drone.'frame'。Frame 与 frame 不同；framePart 不是保留字。
- 单引号表示名称，双引号表示字符串，不能互换。关键字承担语法作用时保持原样；不得对全文、注释、字符串或已经限定的名称做机械替换。
- Validator 报 no viable alternative at input 'frame' 等错误时，先结合诊断位置检查该词是否被用作名称；属于命名冲突时保留其他正确内容，修正名称及其引用后立即提交官方验证，无需为已提供的词表重复检索。其他错误仍按具体诊断处理。
保留字：${asset.keywords.join(" ")}`;
