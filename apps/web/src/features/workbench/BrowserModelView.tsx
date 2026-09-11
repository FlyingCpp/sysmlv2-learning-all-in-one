import { useMemo, useState } from 'react';
import { ChevronRight, FileBox, FolderTree } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BrowserMemberNode, PlantUmlRenderResult } from '../../lib/view/plantuml';
import './browser-model-view.css';

/** 使用服务端官方成员身份；不在浏览器解析 SysML 或从名字推断父子关系。 */
export function BrowserModelView({ tree }: { tree: NonNullable<PlantUmlRenderResult['browserTree']> }) {
  const { i18n } = useTranslation();
  const english = !i18n.resolvedLanguage?.startsWith('zh');
  const [expanded, setExpanded] = useState(() => new Set(tree.nodes.filter(n => n.depth < 1).map(n => n.id)));
  const children = useMemo(() => {
    const result = new Map<string, BrowserMemberNode[]>();
    for (const node of tree.nodes) {
      const members = result.get(node.parentId) || [];
      members.push(node);
      result.set(node.parentId, members);
    }
    return result;
  }, [tree]);
  const toggle = (id: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const renderMembers = (parentId: string) => (
    <ul className="browserMemberList">
      {(children.get(parentId) || []).map(node => {
        const hasChildren = children.has(node.id);
        const isOpen = expanded.has(node.id);
        const label = <>
          {hasChildren ? <ChevronRight size={16} className={isOpen ? 'isOpen' : ''} aria-hidden="true" /> : <FileBox size={16} aria-hidden="true" />}
          <span className="browserMemberText"><span className="browserMemberName">{node.name}</span>
            {node.typeName ? <span className="browserMemberType"> : {node.typeName}</span> : null}
          </span>
          <span className="browserMemberKind">{node.kind.replace(/([a-z])([A-Z])/g, '$1 $2')}</span>
          {hasChildren ? <span className="browserMemberCount">{children.get(node.id)?.length}</span> : null}
        </>;
        return <li key={node.id} data-browser-member={node.id}>
          {hasChildren ? <button className="browserMemberRow" type="button" aria-expanded={isOpen}
            onClick={() => toggle(node.id)} title={node.qualifiedName}>{label}</button>
            : <div className="browserMemberRow" title={node.qualifiedName}>{label}</div>}
          {hasChildren && isOpen ? renderMembers(node.id) : null}
        </li>;
      })}
    </ul>
  );
  return <section className="browserModelView" data-browser-model-view aria-label={english ? 'Model membership browser' : '模型成员层级浏览'}>
    <header className="browserModelHeader">
      <div><strong><FolderTree size={18} aria-hidden="true" />{english ? 'Model hierarchy' : '模型层级'}</strong>
        <p>{english ? 'Expand members to explore. Connections remain declarations within their owner.' : '展开节点浏览成员；连接声明保留在所属元素下。'}</p></div>
      <div className="browserModelActions">
        <span>{tree.nodes.length} {english ? 'elements' : '个元素'}</span>
        <button type="button" onClick={() => setExpanded(new Set(tree.nodes.map(n => n.id)))}>{english ? 'Expand all' : '全部展开'}</button>
        <button type="button" onClick={() => setExpanded(new Set())}>{english ? 'Collapse all' : '全部折叠'}</button>
      </div>
    </header>
    <div className="browserModelScroll" tabIndex={0}>{renderMembers('')}</div>
  </section>;
}
