export type WorkspaceFileSource = 'workspace' | 'reference' | 'draft' | string;

export interface WorkspaceFile {
  path: string;
  content: string;
  editable?: boolean;
  source?: WorkspaceFileSource;
  loadPolicy?: 'always' | 'on-import' | string;
}

export interface WorkspaceSnapshot {
  files: WorkspaceFile[];
  entryFile?: string;
  activeFilePath?: string;
}

export interface CoursePack {
  id: string;
  lineageId?: string;
  dataNamespaceId?: string;
  displayOrder?: number | null;
  slug?: string;
  title?: string;
  name?: string;
  version?: string;
  description?: string;
  language?: string;
  domain?: string;
  sysmlVersion?: string;
  enabled?: boolean;
  homeVisual?: VisualAsset;
  entryCourseId?: string;
  finalProjectId?: string;
  courses?: Course[];
}

export interface Course {
  id: string;
  order?: number;
  title?: string;
  summary?: string;
  description?: string;
  objectives?: string[];
  concepts?: string[];
  lessons?: Array<Lesson | string>;
  conceptExplanations?: ConceptExplanation[];
  references?: ReferenceItem[];
  thumbnail?: VisualAsset;
  visual?: VisualAsset;
  _path?: string;
}

export interface Lesson {
  id: string;
  title?: string;
  courseId?: string;
  type?: string;
  scenario?: {
    body?: string;
    visual?: unknown;
    [key: string]: unknown;
  };
  learningBlocks?: LearningBlock[];
  tasks?: LessonTask[];
  validation?: {
    rules?: unknown;
    [key: string]: unknown;
  };
  workspace?: WorkspaceSnapshot;
  courseConceptExplanations?: unknown[];
  courseReferences?: unknown[];
  references?: unknown[];
  [key: string]: unknown;
}

export interface VisualAsset {
  type?: string;
  src?: string;
  alt?: string;
  title?: string;
  caption?: string;
}

export interface ReferenceItem {
  type?: string;
  source?: string;
  title?: string;
  section?: string;
  url?: string;
  href?: string;
  note?: string;
}

export interface ConceptExplanation {
  id?: string;
  term?: string;
  name?: string;
  aliases?: string[];
  source?: string;
  section?: string;
  metamodelType?: string;
  standardEnglish?: string;
  officialEnglish?: string;
  sourceEnglish?: string;
  chineseTranslation?: string;
  translation?: string;
  explanation?: string;
  definition?: string;
  description?: string;
  engineeringExample?: string;
  example?: string;
}

export interface GlossaryTerm {
  id?: string;
  term?: string;
  name?: string;
  aliases?: string[];
  kind?: string;
  metamodelType?: string;
  superTypes?: string[];
  source?: string;
  section?: string;
  standardEnglish?: string;
  chineseTranslation?: string;
  definition?: string;
  explanation?: string;
  engineeringExample?: string;
}

export interface GlossaryGraphCategory {
  id: string;
  label: string;
  count: number;
}

export interface GlossaryGraphNode {
  id: string;
  label: string;
  termId: string;
  category: string;
  kind?: string;
  metamodelType?: string;
  isPlatformTerm?: boolean;
  aliases?: string[];
  superTypes?: string[];
}

export interface GlossaryGraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'generalization' | string;
  label?: string;
}

export interface GlossaryGraph {
  glossaryId: string;
  generatedAt?: string;
  termCount: number;
  relationshipCount: number;
  categories?: GlossaryGraphCategory[];
  nodes: GlossaryGraphNode[];
  edges: GlossaryGraphEdge[];
}

export interface PlatformAppManifest {
  id: string;
  name: string;
  shortName?: string;
  version?: string;
  description?: string;
  category?: string;
  logo?: string;
  enabled?: boolean;
  order?: number;
  permissions?: string[];
  capabilities?: string[];
  healthCheck?: string;
  runtime: {
    type: 'static-bundle' | 'iframe-service' | 'native-react' | string;
    entryUrl: string;
    sandbox?: string;
    component?: string;
  };
}

export interface PlatformAppsRegistry {
  activeAppId?: string;
  apps: PlatformAppManifest[];
}

export interface UserProfile {
  id: string;
  username?: string;
  email?: string;
  displayName?: string;
  tier?: string;
  roles?: string[];
  permissions?: string[];
  entitlements?: Array<{ code?: string; [key: string]: unknown }>;
}

export interface LearningBlock {
  type?: string;
  content?: string;
  body?: string;
  markdown?: string;
  text?: string;
  sourceFile?: string;
  [key: string]: unknown;
}

export interface LessonTask {
  id?: string;
  title?: string;
  prompt?: string;
  description?: string;
  hints?: string[];
  [key: string]: unknown;
}

export interface ValidationFinding {
  line?: number;
  column?: number;
  severity?: 'error' | 'warning' | string;
  message?: string;
  code?: string;
  studentHint?: unknown;
  [key: string]: unknown;
}

export interface SemanticOutlineNode {
  id: string;
  parentId: string | null;
  name: string;
  declaredName?: string | null;
  qualifiedName?: string | null;
  metaclass: string;
  displayKind: string;
  file?: string | null;
  line?: number | null;
  column?: number | null;
  isImplicit?: boolean;
  isLibrary?: boolean;
  children: SemanticOutlineNode[];
}

export interface SemanticOutline {
  source: string;
  status: 'available' | 'unavailable' | 'invalid' | string;
  generatedAt?: string;
  contentHash?: string;
  roots: SemanticOutlineNode[];
  diagnostics?: ValidationFinding[];
  [key: string]: unknown;
}

export interface ValidationResult {
  ok?: boolean;
  passed?: boolean;
  syntaxValid?: boolean;
  semanticValid?: boolean;
  coursePassed?: boolean;
  findings?: ValidationFinding[];
  diagnostics?: ValidationFinding[];
  rules?: unknown[];
  official?: unknown;
  semanticOutline?: SemanticOutline | null;
  [key: string]: unknown;
}

export interface TeacherEnvelope {
  version: 'host-context-v1';
  mode?: string;
  threadId?: string;
  studentQuestion?: string;
  lesson?: {
    id?: string;
    title?: string;
    courseId?: string;
    courseTitle?: string;
    tasks?: LessonTask[];
    validation?: Lesson['validation'];
  };
  workspace?: WorkspaceSnapshot & {
    selection?: {
      filePath?: string;
      from?: number;
      to?: number;
      text?: string;
    };
  };
  validation?: ValidationResult;
  privacy?: {
    allowExternalProvider?: boolean;
    [key: string]: unknown;
  };
  aiTeacherConversationContext?: unknown;
  [key: string]: unknown;
}
