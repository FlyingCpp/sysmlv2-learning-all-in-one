import type { GlossaryTerm } from '../../lib/course/types';

export const GLOSSARY_GROUPS = [
  { id: 'core', label: 'Core', summary: 'Element、Relationship、Namespace、Package。', terms: ['Element', 'Relationship', 'AnnotatingElement', 'Comment', 'Namespace', 'Package', 'Membership', 'OwningMembership', 'Import', 'Dependency'] },
  { id: 'structure', label: 'Structure', summary: 'Definition / Usage 模式和结构对象。', terms: ['Definition', 'Usage', 'Type', 'Classifier', 'Feature', 'Structure', 'PartDefinition', 'PartUsage', 'ItemDefinition', 'ItemUsage', 'AttributeDefinition', 'AttributeUsage'] },
  { id: 'interface', label: 'Interface', summary: '端口、接口、连接和流。', terms: ['PortDefinition', 'PortUsage', 'InterfaceDefinition', 'InterfaceUsage', 'ConnectionDefinition', 'ConnectionUsage', 'Flow', 'FlowUsage', 'FlowDefinition', 'FlowEnd'] },
  { id: 'behavior', label: 'Behavior', summary: '动作、状态、步骤、转换。', terms: ['Behavior', 'Step', 'ActionDefinition', 'ActionUsage', 'StateDefinition', 'StateUsage', 'TransitionUsage', 'Succession'] },
  { id: 'requirements', label: 'Requirements', summary: '需求、满足和验证目标。', terms: ['RequirementDefinition', 'RequirementUsage', 'RequirementConstraintMembership', 'RequirementVerificationMembership', 'SatisfyRequirementUsage', 'ObjectiveMembership'] },
  { id: 'analysis', label: 'Analysis', summary: '约束、计算、分析案例。', terms: ['ConstraintDefinition', 'ConstraintUsage', 'AssertConstraintUsage', 'CalculationDefinition', 'CalculationUsage', 'AnalysisCaseDefinition', 'AnalysisCaseUsage'] },
  { id: 'view', label: 'View & Metadata', summary: '视图、视点、渲染、元数据。', terms: ['ViewDefinition', 'ViewUsage', 'ViewpointDefinition', 'ViewpointUsage', 'RenderingDefinition', 'RenderingUsage', 'MetadataDefinition', 'MetadataUsage'] }
];

const CATEGORY_RULES = [
  { id: 'core', match: /^(Element|Relationship|Namespace|Package|Membership|OwningMembership|Import|Dependency|Comment|AnnotatingElement)$/ },
  { id: 'structure', match: /(Definition|Usage|Type|Classifier|Feature|Structure|Part|Item|Attribute)/ },
  { id: 'interface', match: /(Port|Interface|Connection|Flow|BindingConnector)/ },
  { id: 'behavior', match: /(Behavior|Step|Action|State|Transition|Succession|Occurrence|Event|Trigger|Perform)/ },
  { id: 'requirements', match: /(Requirement|Satisfy|Verification|Objective|Concern|Case)/ },
  { id: 'analysis', match: /(Constraint|Assert|Calculation|Analysis|Expression|Predicate)/ },
  { id: 'view', match: /(View|Viewpoint|Rendering|Metadata|Documentation|Textual)/ }
];

export function termKey(term?: GlossaryTerm | null): string {
  return term?.term || term?.name || term?.id || '';
}

export function categoryForTerm(name: string): string {
  return CATEGORY_RULES.find((rule) => rule.match.test(name))?.id || 'other';
}
