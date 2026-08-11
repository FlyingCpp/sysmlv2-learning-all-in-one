import { useEffect, useMemo, useRef, useState } from 'react';
import { Network, Search } from 'lucide-react';
import { useGlossaryGraphQuery, useGlossaryQuery } from '../../app/data-hooks';
import type { GlossaryGraph as GlossaryGraphData, GlossaryTerm } from '../../lib/course/types';
import { ErrorState, LoadingState } from '../shared/ui';
import { GeneralizationPath, GlossaryGraph } from './GlossaryGraph';
import { categoryForTerm, GLOSSARY_GROUPS, termKey } from './glossary-graph-model';

export function GlossaryPage() {
  const glossaryQuery = useGlossaryQuery();
  const graphQuery = useGlossaryGraphQuery();
  const [activeGroupId, setActiveGroupId] = useState('structure');
  const [search, setSearch] = useState('');
  const [selectedName, setSelectedName] = useState('Type');
  const termButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const terms = glossaryQuery.data || [];
  const byName = useMemo(() => new Map(terms.map((term) => [termKey(term), term])), [terms]);
  const activeGroup = GLOSSARY_GROUPS.find((group) => group.id === activeGroupId) || GLOSSARY_GROUPS[1];
  const filteredTerms = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (keyword) {
      return terms
        .map((term) => ({ term, score: searchScore(term, keyword) }))
        .filter((entry) => entry.score < 99)
        .sort((left, right) => left.score - right.score || termKey(left.term).localeCompare(termKey(right.term)))
        .map((entry) => entry.term)
        .slice(0, 36);
    }
    return activeGroup.terms.map((name) => byName.get(name)).filter(Boolean) as GlossaryTerm[];
  }, [activeGroup.terms, byName, search, terms]);
  const selected = byName.get(selectedName) || filteredTerms[0] || terms[0];
  const selectedKey = termKey(selected);
  const selectTerm = (name: string) => {
    if (!name) return;
    const nextGroup = categoryForTerm(name);
    if (nextGroup !== 'other') setActiveGroupId(nextGroup);
    setSearch('');
    setSelectedName(name);
  };

  useEffect(() => {
    termButtonRefs.current.get(selectedKey)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedKey, filteredTerms]);

  if (glossaryQuery.isLoading) return <LoadingState label="正在加载术语表" />;
  if (glossaryQuery.error) return <ErrorState error={glossaryQuery.error} />;

  return (
    <section className="glossaryPage" data-glossary-page>
      <section className="glossaryCommandCenter" aria-label="术语表导航">
        <div className="glossaryCommandTopline">
          <div>
            <span className="missionEyebrow">SysML v2 Platform Glossary</span>
            <h2>SysMLv2 OMG术语表</h2>
            <p>统一维护 SysML v2 元模型术语，不随课程包切换；关系图可选择术语并高亮泛化路径。</p>
          </div>
          <label className="glossarySearch" htmlFor="glossarySearch">
            <Search size={17} />
            <input
              id="glossarySearch"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索 metamodel / 语法关键字 / 工程概念"
            />
          </label>
        </div>
        <div className="metamodelNav" role="tablist" aria-label="Metamodel 骨架导航">
          {GLOSSARY_GROUPS.map((group) => (
            <button
              key={group.id}
              type="button"
              aria-current={group.id === activeGroupId}
              aria-pressed={group.id === activeGroupId}
              data-glossary-group={group.id}
              data-selected-term-group={selected ? categoryForTerm(selectedKey) === group.id : undefined}
              onClick={() => {
                setActiveGroupId(group.id);
                setSearch('');
                setSelectedName(group.terms[0] || '');
              }}
            >
              <span>{group.label}</span>
              <small>{group.summary}</small>
            </button>
          ))}
        </div>
      </section>
      <div className="glossaryLayout glossaryExplorer">
        <section className="metamodelCanvas">
          <div className="canvasTopline">
            <div>
              <span className="missionEyebrow">Concept Network</span>
              <h3>{search ? '搜索结果' : activeGroup.label}</h3>
            </div>
            <span>{filteredTerms.length} 个对象</span>
          </div>
          <div className="glossaryGraphToolbar" aria-label="关系图状态">
            <span><Network size={15} />Layered relation graph</span>
            <span>generalization / superType</span>
            {graphQuery.isFetching ? <span>更新关系图</span> : null}
          </div>
          <GlossaryGraph
            graph={graphQuery.data}
            terms={filteredTerms}
            selectedId={selectedKey}
            onSelect={selectTerm}
          />
          <div className="termCloud" aria-label="当前视图术语">
            {filteredTerms.map((term) => {
              const name = termKey(term);
              return (
                <button
                  key={name}
                  ref={(element) => {
                    if (element) termButtonRefs.current.set(name, element);
                    else termButtonRefs.current.delete(name);
                  }}
                  type="button"
                  aria-current={name === selectedKey}
                  data-term-chip={name}
                  title={name}
                  onClick={() => selectTerm(name)}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </section>
        <aside className="termInspector">
          {selected ? (
            <TermInspector
              term={selected}
              graph={graphQuery.data}
              selectedId={selectedKey}
              onSelect={selectTerm}
            />
          ) : <p>请选择术语。</p>}
        </aside>
      </div>
    </section>
  );
}

function searchScore(term: GlossaryTerm, keyword: string) {
  const name = `${term.term || ''} ${term.name || ''} ${term.id || ''}`.toLowerCase();
  if (name.includes(keyword)) return 0;
  if ((term.aliases || []).some((alias) => alias.toLowerCase().includes(keyword))) return 1;
  const body = `${term.definition || ''} ${term.explanation || ''} ${term.standardEnglish || ''} ${term.chineseTranslation || ''} ${term.engineeringExample || ''}`.toLowerCase();
  return body.includes(keyword) ? 2 : 99;
}

function TermInspector({
  term,
  graph,
  selectedId,
  onSelect
}: {
  term: GlossaryTerm;
  graph?: GlossaryGraphData;
  selectedId: string;
  onSelect: (termId: string) => void;
}) {
  const title = termKey(term) || 'Term';
  return (
    <article>
      <header className="inspectorHeader">
        <span>{term.metamodelType || term.kind || 'SysML metamodel'}</span>
        <h3>{title}</h3>
      </header>
      {term.aliases?.length ? <div className="conceptAliases">{term.aliases.map((alias) => <code key={alias}>{alias}</code>)}</div> : null}
      <GeneralizationPath graph={graph} selectedId={selectedId} onSelect={onSelect} />
      {term.superTypes?.length ? <p>superTypes: {term.superTypes.join(', ')}</p> : null}
      {term.standardEnglish ? <section><strong>标准英文原文</strong><p>{term.standardEnglish}</p></section> : null}
      {term.chineseTranslation ? <section><strong>中文翻译</strong><p>{term.chineseTranslation}</p></section> : null}
      <section><strong>概念解释</strong><p>{term.explanation || term.definition || '暂无解释。'}</p></section>
      {term.engineeringExample ? <section><strong>工程案例</strong><p>{term.engineeringExample}</p></section> : null}
    </article>
  );
}
