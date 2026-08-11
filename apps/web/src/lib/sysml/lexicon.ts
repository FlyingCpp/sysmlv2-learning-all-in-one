export const SYSML_LEXICON = {
  coreKeywords: [
    'package', 'private', 'public', 'import', 'library', 'doc',
    'abstract', 'variation', 'variant', 'individual', 'def', 'specializes',
    'subject', 'objective', 'actor', 'in', 'out', 'return', 'first', 'then',
    'else', 'if', 'accept', 'send', 'assign', 'perform', 'expose', 'render',
    'satisfy', 'verify', 'include', 'connect', 'bind', 'metadata'
  ],
  definitionPhrases: [
    'part def', 'item def', 'attribute def', 'port def', 'interface def',
    'connection def', 'allocation def', 'flow def', 'action def', 'state def',
    'requirement def', 'constraint def', 'calc def', 'analysis def',
    'verification def', 'use case def', 'view def', 'viewpoint def',
    'concern def', 'rendering def', 'metadata def'
  ],
  usagePhrases: [
    'part', 'item', 'attribute', 'port', 'ref item', 'ref part', 'ref port',
    'end', 'interface', 'connection', 'allocation', 'flow', 'succession flow',
    'action', 'then action', 'perform action', 'state', 'entry action',
    'do action', 'exit action', 'transition', 'requirement',
    'require constraint', 'assume constraint', 'assert constraint',
    'analysis', 'constraint', 'calc', 'verification', 'use case',
    'include use case', 'view', 'viewpoint', 'expose', 'render'
  ],
  relationPhrases: [
    'satisfy requirement by element;',
    'objective { verify requirement; }',
    'flow source.feature to target.feature;',
    'flow of Item from source to target;',
    'connect end1 to end2;',
    'bind feature = feature;',
    'transition first stateA then stateB;',
    'succession first stepA then stepB;'
  ],
  standardLibraries: [
    'ScalarValues', 'NumericalFunctions', 'CollectionFunctions',
    'StandardViewDefinitions', 'VerificationCases', 'RequirementDerivation',
    'SI', 'ISQ', 'Time', 'Views', 'UseCases', 'Allocations', 'AnalysisCases'
  ],
  scalarTypes: [
    'ScalarValues::Real', 'ScalarValues::Integer', 'ScalarValues::Boolean',
    'ScalarValues::String', 'ScalarValues::Rational', 'ScalarValues::Natural'
  ],
  standardViews: [
    'StandardViewDefinitions::GeneralView',
    'StandardViewDefinitions::BrowserView',
    'StandardViewDefinitions::InterconnectionView',
    'StandardViewDefinitions::ActionFlowView',
    'StandardViewDefinitions::StateTransitionView',
    'StandardViewDefinitions::SequenceView',
    'StandardViewDefinitions::GeometryView',
    'StandardViewDefinitions::GridView'
  ]
} as const;

export const SYSML_HIGHLIGHT_KEYWORDS: ReadonlySet<string> = new Set([
  ...SYSML_LEXICON.coreKeywords,
  ...SYSML_LEXICON.definitionPhrases.flatMap((phrase) => phrase.split(/\s+/)),
  ...SYSML_LEXICON.usagePhrases.flatMap((phrase) => phrase.split(/\s+/)),
  'from', 'to', 'by', 'of', 'redefines', 'subsets', 'references',
  'crosses', 'readonly', 'ordered', 'nonunique'
]);
