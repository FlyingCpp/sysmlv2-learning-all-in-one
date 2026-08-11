import { forwardRef } from 'react';
import {
  Activity,
  Box,
  Boxes,
  Cable,
  CircleDot,
  Component,
  Eye,
  FileCode2,
  GitBranch,
  Import,
  Package,
  PlugZap,
  ShieldCheck,
  Sigma,
  Variable,
  Workflow,
  Wrench,
  type LucideIcon
} from 'lucide-react';
import { RichTreeView } from '@mui/x-tree-view/RichTreeView';
import { TreeItem, type TreeItemProps } from '@mui/x-tree-view/TreeItem';
import { useTreeItemModel } from '@mui/x-tree-view/hooks';

export type MuiModelTreeIconKey =
  | 'package'
  | 'part-definition'
  | 'part-usage'
  | 'port'
  | 'interface'
  | 'item'
  | 'requirement'
  | 'action'
  | 'state'
  | 'import'
  | 'connection'
  | 'attribute'
  | 'view'
  | 'calculation'
  | 'relationship'
  | 'definition'
  | 'usage'
  | 'element';

export interface MuiModelTreeItem {
  id: string;
  label: string;
  kindLabel?: string;
  iconKey?: MuiModelTreeIconKey;
  isImplicit?: boolean;
  isDependency?: boolean;
  title?: string;
  children?: MuiModelTreeItem[];
}

interface MuiModelOutlineTreeProps {
  items: MuiModelTreeItem[];
  defaultExpandedItems: string[];
  onItemClick: (itemId: string) => void;
}

const MODEL_OUTLINE_ICONS: Record<MuiModelTreeIconKey, LucideIcon> = {
  package: Package,
  'part-definition': Component,
  'part-usage': Wrench,
  port: PlugZap,
  interface: Cable,
  item: Box,
  requirement: ShieldCheck,
  action: Activity,
  state: CircleDot,
  import: Import,
  connection: Workflow,
  attribute: Variable,
  view: Eye,
  calculation: Sigma,
  relationship: GitBranch,
  definition: Boxes,
  usage: Wrench,
  element: FileCode2
};

const ModelOutlineTreeItem = forwardRef<HTMLLIElement, TreeItemProps>(function ModelOutlineTreeItem(props, ref) {
  const item = useTreeItemModel<MuiModelTreeItem>(props.itemId);
  const iconKey = item?.iconKey || 'element';
  const Icon = MODEL_OUTLINE_ICONS[iconKey];
  const label = item?.label || String(props.label || 'Element');
  return (
    <TreeItem
      {...props}
      ref={ref}
      label={(
        <span
          className="modelOutlineNodeLabel"
          data-model-dependency={item?.isDependency ? 'true' : 'false'}
          title={item?.title || label}
        >
          <span className="modelOutlineNodeIcon" data-icon-key={iconKey} aria-hidden="true">
            <Icon size={15} strokeWidth={1.8} />
          </span>
          <span className="modelOutlineNodeName">{label}</span>
          {item?.kindLabel ? <span className="modelOutlineNodeKind">{item.kindLabel}</span> : null}
          {item?.isImplicit ? <span className="modelOutlineNodeImplicit">隐式</span> : null}
        </span>
      )}
    />
  );
});

export function MuiModelOutlineTree({
  items,
  defaultExpandedItems,
  onItemClick
}: MuiModelOutlineTreeProps) {
  return (
    <div className="modelOutlineTree modelOutlineTreeMui" data-mui-rich-tree>
      <RichTreeView
        items={items}
        slots={{ item: ModelOutlineTreeItem }}
        defaultExpandedItems={defaultExpandedItems}
        expansionTrigger="iconContainer"
        itemHeight={30}
        onItemClick={(_, itemId) => onItemClick(itemId)}
      />
    </div>
  );
}
