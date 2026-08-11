import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Archive, Boxes, Check, FileArchive, Network, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useSessionStore } from '../../app/session-store';
import { useAppApiClient } from '../../app/use-api-client';
import { ErrorState, LoadingState } from '../shared/ui';

type AdminKnowledgePack = { id: string; title: string; description: string; version: string; status: 'active' | 'disabled' | 'archived'; source: string };
type PendingUpload = { pendingUploadId: string; originalName: string; decision: 'new_pack' | 'new_version' | 'duplicate'; availableActions: string[]; pack: AdminKnowledgePack };

export function KnowledgePackAdminPage() {
  const user = useSessionStore((state) => state.user);
  const canManage = Boolean(user?.roles?.includes('admin') || user?.permissions?.includes('course.pack.manage') || user?.entitlements?.some((item) => item.code === 'course.pack.manage'));
  if (!canManage) return <section className="adminPage"><div className="phase4Hero"><span className="missionEyebrow">Knowledge Pack Admin</span><h2>需要内容包管理权限</h2><p>当前账号没有 course.pack.manage 权限。</p></div></section>;
  return <KnowledgePackAdminPanel />;
}

function KnowledgePackAdminPanel() {
  const api = useAppApiClient();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState('');
  const packsQuery = useQuery({ queryKey: ['admin', 'knowledge-packs'], queryFn: () => api.request<{ packs: AdminKnowledgePack[] }>('/api/admin/knowledge-packs') });
  const pendingQuery = useQuery({ queryKey: ['admin', 'knowledge-packs', 'pending'], queryFn: () => api.request<{ pendingUploads: PendingUpload[] }>('/api/admin/knowledge-packs/upload/pending') });
  const refresh = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ['admin', 'knowledge-packs'] }), queryClient.invalidateQueries({ queryKey: ['admin', 'knowledge-packs', 'pending'] }), queryClient.invalidateQueries({ queryKey: ['knowledge-packs'] })]); };
  const uploadMutation = useMutation({
    mutationFn: (file: File) => { const body = new FormData(); body.append('file', file); return api.request<{ pendingUpload: PendingUpload }>('/api/admin/knowledge-packs/upload/preview', { method: 'POST', body }); },
    onSuccess: async ({ pendingUpload }) => { setNotice(pendingUpload.decision === 'duplicate' ? '内容与现有版本完全相同，未进入发布流程。' : '预览校验通过，请确认后安装为停用状态。'); await refresh(); }
  });
  const confirmMutation = useMutation({ mutationFn: (pendingUploadId: string) => api.request('/api/admin/knowledge-packs/upload/confirm', { method: 'POST', body: { pendingUploadId } }), onSuccess: async () => { setNotice('知识包已安装，启用后将出现在学习端。'); await refresh(); } });
  const abandonMutation = useMutation({ mutationFn: (id: string) => api.request(`/api/admin/knowledge-packs/upload/${encodeURIComponent(id)}`, { method: 'DELETE' }), onSuccess: refresh });
  const lifecycleMutation = useMutation({ mutationFn: ({ pack, action }: { pack: AdminKnowledgePack; action: string }) => action === 'toggle' ? api.request(`/api/admin/knowledge-packs/${encodeURIComponent(pack.id)}`, { method: 'PATCH', body: { enabled: pack.status !== 'active' } }) : api.request(`/api/admin/knowledge-packs/${encodeURIComponent(pack.id)}/${action}`, { method: 'POST' }), onSuccess: refresh });
  const deleteMutation = useMutation({ mutationFn: (id: string) => api.request(`/api/admin/knowledge-packs/${encodeURIComponent(id)}`, { method: 'DELETE' }), onSuccess: refresh });
  const busy = uploadMutation.isPending || confirmMutation.isPending || abandonMutation.isPending || lifecycleMutation.isPending || deleteMutation.isPending;
  const error = uploadMutation.error || confirmMutation.error || abandonMutation.error || lifecycleMutation.error || deleteMutation.error;

  return (
    <section className="adminPage knowledgePackAdminPage" data-knowledge-pack-admin>
      <div className="phase4Hero">
        <span className="missionEyebrow">Knowledge Pack Admin</span><h2>知识包管理</h2>
        <p>知识目录与正文独立于平台代码。ZIP 先经过路径、体积、Schema 与主题引用校验，再确认安装；新内容默认停用。</p>
        <nav className="phase4Checklist adminSectionNav" aria-label="管理后台分区"><Link to="/admin"><Boxes size={14} />账号运营</Link><Link to="/admin/course-packs"><Boxes size={14} />课程包管理</Link><Link className="isActive" to="/admin/knowledge-packs"><Network size={14} />知识包管理</Link><Link to="/admin/ai-teacher"><Boxes size={14} />AI Teacher 管理</Link><Link to="/admin/external-modeling-tools"><Network size={14} />外部建模工具接入</Link></nav>
      </div>
      <section className="adminPanel knowledgePackUploadPanel">
        <header className="sectionHeader"><div><span className="missionEyebrow">Preview before publish</span><h2>上传知识包</h2></div></header>
        <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadMutation.mutate(file); event.currentTarget.value = ''; }} />
        <button className="primaryAction" type="button" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={16} />选择 ZIP 并预览</button>
        <p className="muted">首版上限 25 MB、500 个文件；不接受视频、PDF 或任意 HTML。</p>
        {notice ? <p className="adminInlineNotice"><Check size={15} />{notice}</p> : null}
        {error ? <ErrorState title="知识包操作失败" error={error} /> : null}
      </section>
      {(pendingQuery.data?.pendingUploads || []).map((pending) => <section className="adminPanel knowledgePendingCard" key={pending.pendingUploadId}><div><FileArchive size={22} /><div><strong>{pending.pack.title}</strong><span>{pending.originalName} · {pending.pack.version}</span><p>{pending.decision === 'new_pack' ? '新知识包' : pending.decision === 'new_version' ? '现有知识包的新版本' : '重复内容'}</p></div></div><div className="adminActions">{pending.availableActions.includes('confirm') ? <button type="button" className="primary" disabled={busy} onClick={() => confirmMutation.mutate(pending.pendingUploadId)}>确认安装</button> : null}<button type="button" disabled={busy} onClick={() => abandonMutation.mutate(pending.pendingUploadId)}>放弃</button></div></section>)}
      <section className="adminPanel">
        <header className="sectionHeader"><div><span className="missionEyebrow">Lifecycle</span><h2>已发现的知识包</h2></div></header>
        {packsQuery.isPending ? <LoadingState label="正在加载知识包" /> : packsQuery.error ? <ErrorState title="知识包列表加载失败" error={packsQuery.error} /> : (
          <div className="knowledgePackAdminList">{(packsQuery.data?.packs || []).map((pack) => <article key={pack.id}><div><span className={`knowledgePackStatus ${pack.status}`}>{pack.status === 'active' ? '已启用' : pack.status === 'archived' ? '已归档' : '已停用'}</span><h3>{pack.title}</h3><p>{pack.description}</p><small>{pack.id} · v{pack.version} · {pack.source === 'bundled' ? '内置' : '上传'}</small></div><div className="adminActions">{pack.status !== 'archived' ? <><button type="button" disabled={busy} onClick={() => lifecycleMutation.mutate({ pack, action: 'toggle' })}>{pack.status === 'active' ? '停用' : '启用'}</button><button type="button" disabled={busy} onClick={() => lifecycleMutation.mutate({ pack, action: 'archive' })}><Archive size={14} />归档</button></> : <><button type="button" disabled={busy} onClick={() => lifecycleMutation.mutate({ pack, action: 'restore' })}><RotateCcw size={14} />恢复</button><button type="button" disabled={busy} onClick={() => deleteMutation.mutate(pack.id)}><Trash2 size={14} />删除</button></>}</div></article>)}</div>
        )}
      </section>
    </section>
  );
}
