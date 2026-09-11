/**
 * 视图定义来自OMG Systems Modeling Community维护的SysML v2 Release标准库：
 * sysml.library/Systems Library/StandardViewDefinitions.sysml。
 * 下列8个示例是本项目按全部标准View定义编写的最小模型，并由Official Validator
 * 共同回归；其中前5个还由当前PlantUML专用语义映射回归。完整模型交付会从前5个中
 * 按内容选择可渲染View，但不能把平台渲染能力误写成SysML v2标准库定义范围。
 */
export const PLANTUML_VIEW_FEW_SHOTS = Object.freeze([
  Object.freeze({
    viewDefinition: "StandardViewDefinitions::GeneralView",
    viewName: "GeneralViewExample::vehicleOverview",
    renderMode: "DEFAULT",
    purpose: "通用结构、需求或其他模型元素的节点—边投影",
    selectWhen: "需求模型、通用分解结构、混合元素，或没有更专用的主导关系",
    expectedSvgText: Object.freeze(["Vehicle", "battery"]),
    content: `package GeneralViewExample {
  part def Battery;
  part def Vehicle {
    part battery : Battery;
  }

  part vehicle : Vehicle;

  view vehicleOverview : StandardViewDefinitions::GeneralView {
    expose Vehicle;
    expose vehicle;
  }
}`,
  }),
  Object.freeze({
    viewDefinition: "StandardViewDefinitions::InterconnectionView",
    viewName: "InterconnectionViewExample::systemConnections",
    renderMode: "INTERCONNECTION",
    purpose: "部件、边界特征与连接关系",
    selectWhen: "部件、port、interface、connection或flow构成的连接拓扑是主导内容",
    expectedSvgText: Object.freeze(["producer", "consumer"]),
    content: `package InterconnectionViewExample {
  part def Endpoint {
    port link;
  }

  part system {
    part producer : Endpoint;
    part consumer : Endpoint;
    connect producer.link to consumer.link;
  }

  view systemConnections : StandardViewDefinitions::InterconnectionView {
    expose system;
  }
}`,
  }),
  Object.freeze({
    viewDefinition: "StandardViewDefinitions::ActionFlowView",
    viewName: "ActionFlowViewExample::missionFlow",
    renderMode: "ACTION",
    purpose: "Action及其先后、控制或流关系",
    selectWhen: "action、succession、控制节点或行为流是主导内容",
    expectedSvgText: Object.freeze(["prepare", "execute", "complete"]),
    content: `package ActionFlowViewExample {
  action def MissionFlow {
    action prepare;
    then action execute;
    then action complete;
  }

  view missionFlow : StandardViewDefinitions::ActionFlowView {
    expose MissionFlow;
  }
}`,
  }),
  Object.freeze({
    viewDefinition: "StandardViewDefinitions::StateTransitionView",
    viewName: "StateTransitionViewExample::machineStates",
    renderMode: "STATE",
    purpose: "State及其Transition",
    selectWhen: "state、transition、触发与状态迁移是主导内容",
    expectedSvgText: Object.freeze(["idle", "active"]),
    content: `package StateTransitionViewExample {
  item def Start;

  state def MachineState {
    state idle;
    transition first idle accept Start then active;
    state active;
  }

  view machineStates : StandardViewDefinitions::StateTransitionView {
    expose MachineState;
  }
}`,
  }),
  Object.freeze({
    viewDefinition: "StandardViewDefinitions::SequenceView",
    viewName: "SequenceViewExample::interactionSequence",
    renderMode: "SEQUENCE",
    purpose: "生命线上的事件次序与Message交互",
    selectWhen: "多个参与者之间的message、send/accept或事件时序是主导内容",
    expectedSvgText: Object.freeze(["client", "server", "request", "response"]),
    content: `package SequenceViewExample {
  item def Request;
  item def Response;

  part def Interaction {
    part client[1] {
      event occurrence requestSource;
      then event occurrence responseTarget;
    }

    part server[1] {
      event occurrence requestTarget;
      then event occurrence responseSource;
    }

    message request
      of Request[1]
      from client.requestSource
      to server.requestTarget;

    message response
      of Response[1]
      from server.responseSource
      to client.responseTarget;
  }

  view interactionSequence : StandardViewDefinitions::SequenceView {
    expose Interaction;
  }
}`,
  }),
] as const);

const STANDARD_VIEW_WITHOUT_DEDICATED_RENDERING = Object.freeze([
  Object.freeze({
    viewDefinition: "StandardViewDefinitions::GeometryView",
    viewName: "GeometryViewExample::vehicleGeometry",
    purpose: "二维或三维空间项、形状、坐标系及空间相关量的可视化",
    content: `package GeometryViewExample {
  part def Vehicle;
  part vehicle : Vehicle;

  view vehicleGeometry : StandardViewDefinitions::GeometryView {
    expose vehicle;
  }
}`,
  }),
  Object.freeze({
    viewDefinition: "StandardViewDefinitions::GridView",
    viewName: "GridViewExample::vehicleGrid",
    purpose: "以矩形网格组织模型元素及其关系，包括表格和关系矩阵",
    content: `package GridViewExample {
  part def Vehicle;
  part vehicle : Vehicle;

  view vehicleGrid : StandardViewDefinitions::GridView {
    expose Vehicle;
    expose vehicle;
  }
}`,
  }),
  Object.freeze({
    viewDefinition: "StandardViewDefinitions::BrowserView",
    viewName: "BrowserViewExample::vehicleBrowser",
    purpose: "从一个或多个根元素展示模型元素的层次化membership结构",
    content: `package BrowserViewExample {
  part def Battery;
  part def Vehicle {
    part battery : Battery;
  }

  part vehicle : Vehicle;

  view vehicleBrowser : StandardViewDefinitions::BrowserView {
    expose Vehicle;
    expose vehicle;
  }
}`,
  }),
] as const);

export const SYSML_STANDARD_VIEW_EXAMPLES = Object.freeze([
  ...PLANTUML_VIEW_FEW_SHOTS,
  ...STANDARD_VIEW_WITHOUT_DEDICATED_RENDERING,
] as const);

export const SYSML_STANDARD_VIEW_NAMES = Object.freeze(
  SYSML_STANDARD_VIEW_EXAMPLES.map((example) => example.viewDefinition.split("::").at(-1)!),
);

export const PLANTUML_DEDICATED_VIEW_NAMES = Object.freeze(
  PLANTUML_VIEW_FEW_SHOTS.map((example) => example.viewDefinition.split("::").at(-1)!),
);

const PLANTUML_VIEW_SELECTION_TEXT = PLANTUML_VIEW_FEW_SHOTS
  .map((example) => [
    `- ${example.viewDefinition}（renderMode=${example.renderMode}）`,
    `  选择条件：${example.selectWhen}。`,
    `  呈现重点：${example.purpose}。`,
  ].join("\n"))
  .join("\n");

const STANDARD_VIEW_EXAMPLE_TEXT = SYSML_STANDARD_VIEW_EXAMPLES
  .map((example, index) => [
    `${index + 1}. ${example.viewDefinition}（${example.purpose}）`,
    "```sysml",
    example.content,
    "```",
  ].join("\n"))
  .join("\n\n");

export const SYSML_STANDARD_VIEW_GUIDANCE = `SysML v2标准库StandardViewDefinitions完整定义以下8种标准View；这8种都可以在SysML v2模型中使用：GeneralView、InterconnectionView、ActionFlowView、StateTransitionView、SequenceView、GeometryView、GridView、BrowserView。用户还可以定义标准View的专化或其他自定义View，因此“8种标准View定义”不等于语言只允许8个具体View usage。

以下每个最小示例都使用对应的标准View定义，并必须持续通过本项目Official SysML v2 Validator：

${STANDARD_VIEW_EXAMPLE_TEXT}`;

export const PLANTUML_VIEW_CAPABILITY_GUIDANCE = `当前平台PlantUML只对上述8种标准View中的以下5种提供专用语义映射：GeneralView、InterconnectionView、ActionFlowView、StateTransitionView、SequenceView。GeometryView、GridView和BrowserView仍是SysML v2标准库View，但当前没有对应的专用PlantUML渲染模式；其他自定义View通常也没有专用映射。“没有平台专用渲染”绝不等于“不是标准View”，也不得把“平台专用支持5种”改写成“SysML v2标准库只有5种”。即使通用后端能够产生图形，也不能声称已经按Geometry、Grid、Browser或其他未映射View的专用语义完整呈现。`;

export const PLANTUML_VIEW_SELECTION_GUIDANCE = `完整SysML v2模型交付的PlantUML可渲染View选择清单：
${PLANTUML_VIEW_SELECTION_TEXT}`;

export const PLANTUML_VIEW_KNOWLEDGE_GUIDANCE = `${SYSML_STANDARD_VIEW_GUIDANCE}

平台渲染能力边界：
${PLANTUML_VIEW_CAPABILITY_GUIDANCE}

当前Official Pilot的InterconnectionView应优先expose直接拥有目标子部件与连接的上下文。如果连接定义在part def内部，应expose该定义；仅expose一个以它为类型的包级usage，或逐个expose内部部件/命名连接，可能只得到孤立方框。不要为此移动领域结构、给所有连接补名字或承诺一定可见；以实际渲染核对端口和连接。依据：2026-09-05同一电池包的官方渲染对照，expose拥有者定义保留原模型并显示全部9条连接，见迭代验收记录。`;

export const PLANTUML_VIEW_RESPONSE_GUIDANCE = `${PLANTUML_VIEW_KNOWLEDGE_GUIDANCE}

终末回答职责：如果学生明确要求生成的View超出当前平台5种专用PlantUML映射，最终回答必须说明：所请求的View是否属于SysML v2标准库、模型是否已经生成并通过实际Validator，以及平台当前不能按该View的专用语义完成渲染。必须列出平台专用支持的5种View，但不得把学生请求偷换为其中一种，也不得因渲染不支持而否定一个语义正确且已经实际通过Validator的SysML v2 View模型。这个公开能力边界只在最终回答中形成，不要求建模Worker自行撰写面向学生的说明。`;

/**
 * Finalizer只需要公开能力边界，不需要重复接收Candidate/Repair使用的8组语法示例。
 * 该投影仅在服务端识别到相关View时注入，避免无关Direct Answer占用终态窗口。
 */
export const PLANTUML_VIEW_FINALIZER_GUIDANCE = `SysML v2标准库StandardViewDefinitions定义GeneralView、InterconnectionView、ActionFlowView、StateTransitionView、SequenceView、GeometryView、GridView、BrowserView；平台当前只为前5种提供专用PlantUML语义映射。GeometryView、GridView、BrowserView仍是标准View，但当前没有对应的专用渲染模式。“没有平台专用渲染”不等于“不是标准View”。

终末回答职责：如果学生明确要求生成的View超出当前平台5种专用PlantUML映射，最终回答必须说明：所请求的View是否属于SysML v2标准库、模型是否已经生成并通过实际Validator，以及平台当前不能按该View的专用语义完成渲染。必须列出平台专用支持的5种View，但不得把学生请求偷换为其中一种，也不得因渲染不支持而否定一个语义正确且已经实际通过Validator的SysML v2 View模型。`;

export const PLANTUML_VIEW_MODELING_GUIDANCE = `${PLANTUML_VIEW_KNOWLEDGE_GUIDANCE}

${PLANTUML_VIEW_SELECTION_GUIDANCE}

SysML v2 View交付规则：
- 当前Worker要交付新增、补全或修改后的完整SysML v2模型候选时，候选中必须包含至少一个显式view usage及其expose，使交付可直接进入平台PlantUML渲染查看。纯解释、纯分析或没有模型候选交付的任务不适用此规则。
- 先阅读完整候选中真实存在的元素和关系，再按上述5项选择清单匹配主导语义；不得仅根据学生提问中的单个关键词选型。需求为主、普通结构或混合内容默认选GeneralView；只在连接拓扑、行为流、状态迁移或交互时序确实是主导内容时，分别选InterconnectionView、ActionFlowView、StateTransitionView或SequenceView。
- 模型同时包含多个对立且有展示价值的方面时，可为每个方面生成一个聚焦View；不得为了穷举清单而生成重复View，也不得把所有元素无区分地塞进多个View。
- 默认交付新View时只从上述5种有专用PlantUML映射的类型中选择。学生明确指定GeometryView、GridView、BrowserView或自定义View时，才按其语义要求生成非专用映射View，不得偷换为其他类型。
- 如果授权基线已包含与当前内容匹配且有效的可渲染View，保留并在展示范围发生变化时同步更新；如果已有View类型与修改后的主导内容不匹配，将其改为正确类型或增加聚焦View。
- expose属于view usage。使用\`view name : StandardViewDefinitions::... { expose ...; }\`；禁止生成\`view def Name { expose ...; }\`。view def用于定义可复用的筛选/渲染规则，不是承载本次expose目标的usage。
- expose目标必须真实存在，且应选择能使该View的核心元素和关系可见的最小充分范围；不得为了View虚构新的领域元素。\`::**\`表示递归暴露命名空间成员，不表示沿part typing关系递归展开。
- 学生明确要求GeometryView、GridView、BrowserView或其他当前没有专用映射的View时，仍应生成所请求类型的语义正确模型并交给Official Validator；不得为了获得平台专用渲染而替换成5种已映射View之一。
- 只把上面的示例当作选型与语法参考，不得把示例中的领域名称复制到学生模型。`;
