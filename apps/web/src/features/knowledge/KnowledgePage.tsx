import { keepPreviousData, useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, BookOpenText, Check, ChevronDown, ExternalLink, Info, Maximize2, Menu, Minimize2, Network, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppApiClient } from '../../app/use-api-client';
import type { Lesson, WorkspaceSnapshot } from '../../lib/course/types';
import { AiTeacherPanel } from '../ai-teacher/AiTeacherPanel';
import { EmptyState, ErrorState, LoadingState } from '../shared/ui';
import { KnowledgeCodeBlockView, KnowledgePdfBlockView, KnowledgeVideoBlockView, type KnowledgeMediaBlock } from './KnowledgeMediaBlocks';

type KnowledgePackSummary = { id: string; title: string; description: string; version: string; entryTopicId: string; contentVersionId: string; domainCount?: number; topicCount?: number };
type KnowledgeTopicSummary = { id: string; domainId: string; title: string; summary: string; order: number; estimatedMinutes: number };
type KnowledgeDomain = { id: string; title: string; description: string; order: number; topics: KnowledgeTopicSummary[] };
type KnowledgeReference = { id: string; title: string; author?: string; url?: string; note?: string };
type KnowledgeTextBlock = { id: string; type: 'markdown' | 'image' | 'callout' | 'references' | 'concept-map'; content?: string; asset?: string; alt?: string; caption?: string; title?: string; body?: string; tone?: string; referenceIds?: string[] };
type KnowledgeBlock = KnowledgeTextBlock | KnowledgeMediaBlock;
type KnowledgePack = KnowledgePackSummary & { domains: KnowledgeDomain[]; references: KnowledgeReference[] };
type KnowledgeTopic = KnowledgeTopicSummary & { previousTopicId?: string; nextTopicId?: string; blocks: KnowledgeBlock[]; references: KnowledgeReference[]; pack: KnowledgePackSummary };
type KnowledgeProgress = { packId: string; topicProgress: Record<string, { percent: number; completed: boolean; blockId?: string; updatedAt: string }> };

export function KnowledgeIndexPage() {
  const api = useAppApiClient();
  const navigate = useNavigate();
  const [searchValue, setSearchValue] = useState('');
  const packsQuery = useQuery({ queryKey: ['knowledge-packs'], queryFn: () => api.request<{ packs: KnowledgePackSummary[] }>('/api/knowledge-packs') });
  const packs = packsQuery.data?.packs || [];
  const packDetailQueries = useQueries({
    queries: packs.map((pack) => ({
      queryKey: ['knowledge-pack', pack.id],
      queryFn: () => api.request<KnowledgePack>(`/api/knowledge-packs/${encodeURIComponent(pack.id)}`),
      staleTime: 60_000
    }))
  });
  const enrichedPacks = useMemo(() => packs.map((pack, index) => {
    const detail = packDetailQueries[index]?.data;
    if (!detail) return pack;
    return {
      ...pack,
      domainCount: detail.domains.length,
      topicCount: detail.domains.reduce((count, domain) => count + domain.topics.length, 0)
    };
  }), [packDetailQueries, packs]);
  const filteredPacks = useMemo(() => filterKnowledgeSpaces(enrichedPacks, searchValue), [enrichedPacks, searchValue]);
  const teacherContext = useMemo(() => buildKnowledgeLibraryTeacherContext(enrichedPacks), [enrichedPacks]);
  if (packsQuery.isPending) return <LoadingState label="正在打开工程知识库" />;
  if (packsQuery.error) return <ErrorState title="工程知识库加载失败" error={packsQuery.error} />;
  if (!packs.length) return <EmptyState>当前没有已发布的知识空间。管理员可在内容管理中上传并启用内容。</EmptyState>;
  return (
    <section className="knowledgeLibraryPage" data-knowledge-library>
      <AiTeacherPanel
        lesson={teacherContext.lesson}
        workspace={teacherContext.workspace}
        activeFilePath={teacherContext.workspace.entryFile}
        defaultOpen
        launcherMode="none"
        presentation="knowledge-page"
        knowledgeWorkspace={{
          spaceCount: filteredPacks.length,
          spaces: (
            <section className="knowledgeLibrarySpaces" id="knowledge-spaces" aria-labelledby="knowledge-spaces-title" tabIndex={-1}>
              <div className="knowledgeLibrarySpacesToolbar">
                <div><span>持续更新</span><h2 id="knowledge-spaces-title">知识空间</h2><p>浏览可独立发布、版本化和持续维护的工程主题。</p></div>
                <KnowledgeSearch value={searchValue} onChange={setSearchValue} placeholder="搜索知识空间" label="搜索工程知识库" />
              </div>
              <div className="knowledgeLibrarySpacesCount">{filteredPacks.length} 个空间</div>
              <KnowledgeSpaceList
                packs={filteredPacks}
                onEnter={(pack) => void navigate({ to: '/knowledge/$packId/$topicId', params: { packId: pack.id, topicId: pack.entryTopicId } })}
              />
              {!filteredPacks.length ? <p className="knowledgeSpaceEmpty">没有找到匹配的知识空间或文章。</p> : null}
              <footer className="knowledgeLibraryFooter"><Info size={16} />知识空间由后台发布、启用与版本化</footer>
            </section>
          )
        }}
      />
    </section>
  );
}

export function KnowledgePage({ packId, topicId }: { packId: string; topicId: string }) {
  const api = useAppApiClient();
  const navigate = useNavigate();
  const [treeOpen, setTreeOpen] = useState(false);
  const [treeMode, setTreeMode] = useState<'spaces' | 'outline'>('outline');
  const [spaceSearch, setSpaceSearch] = useState('');
  const [topicSearch, setTopicSearch] = useState('');
  const [activeBlockId, setActiveBlockId] = useState('');
  const [scrollPercent, setScrollPercent] = useState(0);
  const articleRef = useRef<HTMLElement>(null);
  const readingScrollRef = useRef<HTMLElement>(null);
  const packsQuery = useQuery({ queryKey: ['knowledge-packs'], queryFn: () => api.request<{ packs: KnowledgePackSummary[] }>('/api/knowledge-packs') });
  const packQuery = useQuery({ queryKey: ['knowledge-pack', packId], queryFn: () => api.request<KnowledgePack>(`/api/knowledge-packs/${encodeURIComponent(packId)}`) });
  const topicQuery = useQuery({
    queryKey: ['knowledge-topic', packId, topicId],
    queryFn: () => api.request<KnowledgeTopic>(`/api/knowledge-packs/${encodeURIComponent(packId)}/topics/${encodeURIComponent(topicId)}`),
    placeholderData: keepPreviousData
  });
  const progressQuery = useQuery({ queryKey: ['knowledge-progress', packId], queryFn: () => api.request<KnowledgeProgress>(`/api/knowledge-progress/${encodeURIComponent(packId)}`) });
  const progressMutation = useMutation({
    mutationFn: (next: KnowledgeProgress) => api.request<KnowledgeProgress>(`/api/knowledge-progress/${encodeURIComponent(packId)}`, { method: 'PUT', body: next })
  });
  const topics = useMemo(() => packQuery.data?.domains.flatMap((domain) => domain.topics) || [], [packQuery.data]);
  const filteredDomains = useMemo(() => filterKnowledgeDomains(packQuery.data?.domains || [], topicSearch), [packQuery.data, topicSearch]);
  const topic = topicQuery.data;

  useEffect(() => {
    setTreeOpen(false);
    setTreeMode('outline');
    setTopicSearch('');
    setActiveBlockId('');
    setScrollPercent(0);
  }, [topicId]);

  useEffect(() => {
    const scroller = readingScrollRef.current;
    const article = articleRef.current;
    if (!topic || !scroller || !article) return undefined;
    scroller.scrollTo({ top: 0 });
    const elements = [...article.querySelectorAll<HTMLElement>('[data-knowledge-block]')];
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible?.target.id) setActiveBlockId(visible.target.id);
    }, { root: scroller, rootMargin: '-18% 0px -62% 0px', threshold: [0, 0.1] });
    elements.forEach((element) => observer.observe(element));
    const updateProgress = () => {
      const readableHeight = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      setScrollPercent(Math.round(Math.min(1, scroller.scrollTop / readableHeight) * 100));
    };
    const resizeObserver = new ResizeObserver(updateProgress);
    resizeObserver.observe(scroller);
    resizeObserver.observe(article);
    updateProgress();
    scroller.addEventListener('scroll', updateProgress, { passive: true });
    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      scroller.removeEventListener('scroll', updateProgress);
    };
  }, [topic]);

  useEffect(() => {
    if (!topic || progressQuery.isPending || scrollPercent < 5) return undefined;
    const timer = window.setTimeout(() => {
      const current = progressQuery.data || { packId, topicProgress: {} };
      const previous = current.topicProgress[topic.id]?.percent || 0;
      if (scrollPercent <= previous && !(scrollPercent >= 90 && !current.topicProgress[topic.id]?.completed)) return;
      progressMutation.mutate({
        packId,
        topicProgress: {
          ...current.topicProgress,
          [topic.id]: { percent: Math.max(previous, scrollPercent), completed: scrollPercent >= 90, blockId: activeBlockId, updatedAt: new Date().toISOString() }
        }
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [activeBlockId, packId, progressMutation, progressQuery.data, progressQuery.isPending, scrollPercent, topic]);

  if (packQuery.isPending || (topicQuery.isPending && !topicQuery.data)) return <LoadingState label="正在加载知识内容" />;
  if (packQuery.error || topicQuery.error) return <ErrorState title="知识内容加载失败" error={packQuery.error || topicQuery.error} />;
  if (!packQuery.data || !topic) return <EmptyState>没有找到这个知识主题。</EmptyState>;

  const domain = packQuery.data.domains.find((item) => item.id === topic.domainId);
  const topicIndex = topics.findIndex((item) => item.id === topic.id);
  const previous = topics.find((item) => item.id === topic.previousTopicId) || topics[topicIndex - 1];
  const next = topics.find((item) => item.id === topic.nextTopicId) || topics[topicIndex + 1];
  const savedProgress = progressQuery.data?.topicProgress || {};
  const packProgress = knowledgeProgressPercent(packQuery.data.topicCount || topics.length, progressQuery.data);
  const teacherContext = buildKnowledgeTeacherContext(topic);
  const visibleSpaces = filterKnowledgeSpaces(packsQuery.data?.packs || [], spaceSearch);

  const enterSpace = (pack: KnowledgePackSummary) => {
    setTreeMode('outline');
    setSpaceSearch('');
    if (pack.id === packId) return;
    setTreeOpen(false);
    void navigate({ to: '/knowledge/$packId/$topicId', params: { packId: pack.id, topicId: pack.entryTopicId } });
  };

  return (
    <section className="knowledgeReader" data-knowledge-reader>
      <button className="knowledgeTreeToggle" type="button" aria-expanded={treeOpen} onClick={() => setTreeOpen(true)}><Menu size={17} />目录</button>
      <aside className={`knowledgeTree${treeOpen ? ' isOpen' : ''}`} aria-label="工程知识库目录" data-knowledge-tree-mode={treeMode}>
        {treeMode === 'spaces' ? <>
          <header className="knowledgeSpacesHeader">
            <span className="knowledgeTreeMark"><Network size={20} /></span>
            <div><strong>工程知识库</strong><small>{visibleSpaces.length} 个知识空间</small></div>
            <button className="knowledgeTreeClose" type="button" onClick={() => setTreeOpen(false)} aria-label="关闭工程知识库"><X size={18} /></button>
          </header>
          <div className="knowledgeSpacesPanel">
            <KnowledgeSearch value={spaceSearch} onChange={setSpaceSearch} placeholder="搜索知识空间或文章" label="搜索知识空间" />
            <div className="knowledgeSpaceSectionHeader"><div><h2>知识空间</h2><span>{visibleSpaces.length} 个空间</span></div></div>
            <KnowledgeSpaceList packs={visibleSpaces} currentPackId={packId} onEnter={enterSpace} compact />
            {!visibleSpaces.length ? <p className="knowledgeSpaceEmpty">没有找到匹配的知识空间。</p> : null}
          </div>
          <footer><Info size={15} />知识空间由后台发布与版本化</footer>
        </> : <>
          <header className="knowledgeOutlineHeader">
            <div className="knowledgeTreeHeaderActions">
              <button className="knowledgeTreeBack" type="button" onClick={() => setTreeMode('spaces')}><ArrowLeft size={16} />知识空间</button>
              <button className="knowledgeTreeClose" type="button" onClick={() => setTreeOpen(false)} aria-label="关闭空间目录"><X size={18} /></button>
            </div>
            <strong>{packQuery.data.title}</strong>
            <small>进度 {packProgress}% · 内容版本 {packQuery.data.version}</small>
            <KnowledgeSearch value={topicSearch} onChange={setTopicSearch} placeholder="搜索本空间" label="搜索本知识空间" />
          </header>
          <nav className="knowledgeOutlineNav">
            {filteredDomains.map((item) => (
              <details key={item.id} open={Boolean(topicSearch.trim()) || item.id === topic.domainId}>
                <summary>{item.title}<ChevronDown size={15} /></summary>
                <div>
                  {item.topics.map((entry) => (
                    <Link key={entry.id} to="/knowledge/$packId/$topicId" params={{ packId, topicId: entry.id }} className={entry.id === topic.id ? 'isActive' : ''} onClick={() => setTreeOpen(false)}>
                      <span>{savedProgress[entry.id]?.completed ? <Check size={13} /> : null}</span>
                      <div><strong>{entry.title}</strong><small>{entry.estimatedMinutes ? `约 ${entry.estimatedMinutes} 分钟` : ''}</small></div>
                    </Link>
                  ))}
                </div>
              </details>
            ))}
            {!filteredDomains.length ? <p className="knowledgeSpaceEmpty">本空间中没有匹配的文章。</p> : null}
          </nav>
          <footer><BookOpenText size={15} />空间说明与更新记录</footer>
        </>}
      </aside>
      {treeOpen ? <button className="knowledgeTreeScrim" aria-label="关闭知识目录" onClick={() => setTreeOpen(false)} /> : null}

      <div className="workbenchAiDockLayout knowledgeContentDockLayout" data-ai-teacher-dock-layout>
        <main className="knowledgeReadingColumn" ref={readingScrollRef} data-knowledge-scroll-region aria-busy={topicQuery.isPlaceholderData}>
          <div className="knowledgeProgressBar" aria-label={`阅读进度 ${scrollPercent}%`}><span style={{ width: `${scrollPercent}%` }} /></div>
          {topicQuery.isPlaceholderData ? <span className="srOnly" role="status">正在切换知识主题</span> : null}
          <div className="knowledgeReadingBody">
            <div className="knowledgeReadingMeta"><span>当前 {topicIndex + 1} / {topics.length}</span><span>约 {topic.estimatedMinutes || 8} 分钟</span><span>{scrollPercent}%</span></div>
            <div className="knowledgeBreadcrumb"><span>{domain?.title}</span><span>/</span><span>{topic.title}</span></div>
            <article className="knowledgeArticle" ref={articleRef}>
              <header className="knowledgeArticleHeader"><p>{domain?.description}</p><h1>{topic.title}</h1><div>{topic.summary}</div></header>
              {topic.blocks.map((block) => <KnowledgeBlockView key={block.id} block={block} topic={topic} active={activeBlockId === block.id} />)}
            </article>
            <nav className="knowledgeTopicNav" aria-label="主题切换">
              {previous ? <Link to="/knowledge/$packId/$topicId" params={{ packId, topicId: previous.id }}><ArrowLeft size={17} /><span><small>上一主题</small><strong>{previous.title}</strong></span></Link> : <span />}
              {next ? <Link to="/knowledge/$packId/$topicId" params={{ packId, topicId: next.id }}><span><small>下一主题</small><strong>{next.title}</strong></span><ArrowRight size={17} /></Link> : null}
            </nav>
          </div>
        </main>
        <AiTeacherPanel lesson={teacherContext.lesson} workspace={teacherContext.workspace} activeFilePath={teacherContext.workspace.entryFile} launcherMode="floating" />
      </div>
    </section>
  );
}

function KnowledgeSearch({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder: string; label: string }) {
  return <label className="knowledgeSearch">
    <Search size={17} />
    <input value={value} onChange={(event) => onChange(event.currentTarget.value)} placeholder={placeholder} aria-label={label} />
    {value ? <button type="button" onClick={() => onChange('')} aria-label={`清除${label}`}><X size={14} /></button> : null}
  </label>;
}

function KnowledgeSpaceList({ packs, currentPackId, onEnter, compact = false }: { packs: KnowledgePackSummary[]; currentPackId?: string; onEnter: (pack: KnowledgePackSummary) => void; compact?: boolean }) {
  return <div className={`knowledgeSpaceList${compact ? ' isCompact' : ''}`}>
    {packs.map((pack, index) => <KnowledgeSpaceListItem key={pack.id} pack={pack} index={index} current={pack.id === currentPackId} onEnter={onEnter} />)}
  </div>;
}

function KnowledgeSpaceListItem({ pack, index, current, onEnter }: { pack: KnowledgePackSummary; index: number; current: boolean; onEnter: (pack: KnowledgePackSummary) => void }) {
  const api = useAppApiClient();
  const progressQuery = useQuery({
    queryKey: ['knowledge-progress', pack.id],
    queryFn: () => api.request<KnowledgeProgress>(`/api/knowledge-progress/${encodeURIComponent(pack.id)}`)
  });
  const progress = knowledgeProgressPercent(pack.topicCount || 0, progressQuery.data);
  return <article className={`knowledgeSpaceItem${current ? ' isCurrent' : ''}`} data-knowledge-space-id={pack.id}>
    <div className="knowledgeSpaceItemMain">
      <span className="knowledgeSpaceIndex">{index + 1}.</span>
      <div><h3>{pack.title}</h3><p>{pack.description || '独立发布和持续维护的工程知识空间。'}</p></div>
      <strong className="knowledgeSpaceProgress">{progress}%</strong>
    </div>
    <div className="knowledgeSpaceMeta">
      <span>{pack.domainCount || 0} 单元</span><span>{pack.topicCount || 0} 主题</span><span>内容版本 {pack.version}</span>
      <button type="button" onClick={() => onEnter(pack)}>{current ? '返回目录' : '进入目录'}<ArrowRight size={16} /></button>
    </div>
  </article>;
}

function filterKnowledgeSpaces(packs: KnowledgePackSummary[], query: string) {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return packs;
  return packs.filter((pack) => `${pack.title}\n${pack.description}`.toLocaleLowerCase().includes(term));
}

function filterKnowledgeDomains(domains: KnowledgeDomain[], query: string) {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return domains;
  return domains.map((domain) => ({
    ...domain,
    topics: domain.topics.filter((topic) => `${topic.title}\n${topic.summary}`.toLocaleLowerCase().includes(term))
  })).filter((domain) => domain.title.toLocaleLowerCase().includes(term) || domain.description.toLocaleLowerCase().includes(term) || domain.topics.length);
}

function knowledgeProgressPercent(topicCount: number, progress?: KnowledgeProgress) {
  if (!topicCount || !progress) return 0;
  const total = Object.values(progress.topicProgress || {}).reduce((sum, item) => sum + Math.min(100, Math.max(0, Number(item.percent) || 0)), 0);
  return Math.round(total / topicCount);
}

function buildKnowledgeLibraryTeacherContext(packs: KnowledgePackSummary[]): { lesson: Lesson; workspace: WorkspaceSnapshot } {
  const catalog = packs.map((pack) => [
    `## ${pack.title}`,
    pack.description || '独立发布和持续维护的工程知识空间。',
    `内容版本：${pack.version}；单元：${pack.domainCount || 0}；主题：${pack.topicCount || 0}。`
  ].join('\n')).join('\n\n');
  const content = [
    '# 工程知识库',
    '面向 SysML v2、系统工程和 MBSE 的概念解释、方法导读和知识空间导航。',
    '当问题涉及语言语义或语法时，应以 OMG SysML v2 规范、官方示例与 Validator 证据为准。',
    catalog
  ].join('\n\n');
  const workspace: WorkspaceSnapshot = {
    entryFile: 'engineering-knowledge-catalog.md',
    activeFilePath: 'engineering-knowledge-catalog.md',
    files: [{ path: 'engineering-knowledge-catalog.md', content, editable: false, source: 'workspace' }]
  };
  const lesson: Lesson = {
    id: 'engineering-knowledge-library',
    courseId: 'engineering-knowledge-library',
    title: '工程知识库 AI Teacher',
    summary: '围绕 SysML v2、系统工程、MBSE 和已发布知识空间进行概念解释、对比和导读。',
    tasks: [{ id: 'knowledge-guidance', title: '工程知识导读', prompt: '解释概念、给出工程上下文，并引导用户阅读相关知识空间。' }],
    workspace
  };
  return { lesson, workspace };
}

function buildKnowledgeTeacherContext(topic: KnowledgeTopic): { lesson: Lesson; workspace: WorkspaceSnapshot } {
  const content = [
    `# ${topic.title}`,
    topic.summary,
    ...topic.blocks.flatMap(knowledgeBlockTeacherText),
    ...topic.references.map((reference) => `${reference.title} — ${reference.author || ''}: ${reference.note || ''}`)
  ].join('\n\n');
  const workspace: WorkspaceSnapshot = {
    entryFile: 'knowledge-context.md',
    activeFilePath: 'knowledge-context.md',
    files: [{ path: 'knowledge-context.md', content, editable: false, source: 'workspace' }]
  };
  const lesson: Lesson = {
    id: `knowledge-${topic.pack.id}-${topic.id}`,
    courseId: `knowledge-${topic.pack.id}`,
    title: topic.title,
    summary: topic.summary,
    tasks: [{ id: 'understand', title: '理解当前知识', prompt: '围绕当前知识主题进行解释、举例、对比和追问。' }],
    workspace
  };
  return { lesson, workspace };
}

function knowledgeBlockTeacherText(block: KnowledgeBlock): string[] {
  const text: string[] = [];
  if ('title' in block && block.title) text.push(block.title);
  if ('content' in block && block.content) text.push(block.content);
  if ('body' in block && block.body) text.push(block.body);
  if ('caption' in block && block.caption) text.push(block.caption);
  if (block.type === 'video') text.push(`外部视频 Provider：${block.provider}；${block.videoId ? `videoId=${block.videoId}` : `playlistId=${block.playlistId || ''}`}`);
  if (block.type === 'pdf') text.push(`PDF 资产：${block.asset}`);
  return text;
}

function KnowledgeBlockView({ block, topic, active }: { block: KnowledgeBlock; topic: KnowledgeTopic; active: boolean }) {
  const id = `block-${block.id}`;
  if (block.type === 'markdown') return <section id={id} data-knowledge-block className={`knowledgeBlock knowledgeMarkdown${active ? ' isActive' : ''}`}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}<ExternalLink size={12} /></a>,
        code: ({ children, className, node: _node, ...props }) => {
          const value = String(children).trim();
          const referenceKey = /^REF-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(value);
          const classes = [className, referenceKey ? 'knowledgeReferenceKey' : 'knowledgeInlineCode'].filter(Boolean).join(' ');
          return <code {...props} className={classes}>{children}</code>;
        }
      }}
    >{block.content || ''}</ReactMarkdown>
  </section>;
  if (block.type === 'image') return <KnowledgeImageBlockView id={id} block={block} topic={topic} active={active} />;
  if (block.type === 'concept-map') return <section id={id} data-knowledge-block className={`knowledgeBlock knowledgeConceptMap${active ? ' isActive' : ''}`}><h2>{block.title}</h2><div>{['现实系统','对象与关系','面向决策的视图','需求与验证证据'].map((label, index) => <div key={label}><span>{index + 1}</span><strong>{label}</strong><small>{['复杂、多维、持续演化','选择关键元素并建立语义','按关注点组织信息','用可复核结果闭合判断'][index]}</small></div>)}</div></section>;
  if (block.type === 'callout') return <aside id={id} data-knowledge-block className={`knowledgeBlock knowledgeCallout ${block.tone || 'note'}${active ? ' isActive' : ''}`}><strong>{block.title}</strong><p>{block.body}</p></aside>;
  if (block.type === 'code') return <section id={id} data-knowledge-block className={`knowledgeBlock knowledgeMediaBlock${active ? ' isActive' : ''}`}><KnowledgeCodeBlockView block={block} /></section>;
  if (block.type === 'pdf') return <section id={id} data-knowledge-block className={`knowledgeBlock knowledgeMediaBlock${active ? ' isActive' : ''}`}><KnowledgePdfBlockView block={block} assetUrl={knowledgeAssetUrl(topic, block.asset)} /></section>;
  if (block.type === 'video') return <section id={id} data-knowledge-block className={`knowledgeBlock knowledgeMediaBlock${active ? ' isActive' : ''}`}><KnowledgeVideoBlockView block={block} /></section>;
  if (block.type === 'references') {
    const refs = topic.references.filter((item) => block.referenceIds?.includes(item.id));
    return <section id={id} data-knowledge-block className={`knowledgeBlock knowledgeReferences${active ? ' isActive' : ''}`}><h2>参考资料</h2>{refs.map((reference) => <a key={reference.id} href={reference.url} target="_blank" rel="noreferrer"><div><strong>{reference.title}</strong><span>{reference.author}</span><p>{reference.note}</p></div><ExternalLink size={17} /></a>)}</section>;
  }
  return null;
}

function KnowledgeImageBlockView({ id, block, topic, active }: { id: string; block: KnowledgeTextBlock; topic: KnowledgeTopic; active: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const assetUrl = knowledgeAssetUrl(topic, block.asset || '');
  const label = block.alt || block.caption || '知识插图';
  useEffect(() => setExpanded(false), [assetUrl]);
  return <figure id={id} data-knowledge-block className={`knowledgeBlock knowledgeFigure isWide${expanded ? ' isExpanded' : ''}${active ? ' isActive' : ''}`}>
    <header className="knowledgeFigureHeader">
      <span>教学图</span>
      <div>
        <button type="button" onClick={() => setExpanded((value) => !value)} aria-pressed={expanded} aria-label={`${expanded ? '适应宽度' : '放大阅读'}：${label}`}>
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}{expanded ? '适应宽度' : '放大阅读'}
        </button>
        <a href={assetUrl} target="_blank" rel="noreferrer" aria-label={`查看原图：${label}`}><ExternalLink size={15} />查看原图</a>
      </div>
    </header>
    <div className="knowledgeFigureViewport">
      <img src={assetUrl} alt={label} loading="eager" decoding="async" />
    </div>
    {block.caption ? <figcaption>{block.caption}</figcaption> : null}
  </figure>;
}

function knowledgeAssetUrl(topic: KnowledgeTopic, asset: string): string {
  return `/api/knowledge-assets/${encodeURIComponent(topic.pack.id)}/${encodeURIComponent(topic.pack.contentVersionId)}/${asset.split('/').map(encodeURIComponent).join('/')}`;
}
