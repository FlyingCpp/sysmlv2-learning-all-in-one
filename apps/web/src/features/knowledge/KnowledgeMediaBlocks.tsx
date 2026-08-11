import { CheckCircle2, CircleAlert, Clipboard, Download, ExternalLink, FileCode2, FileText, LoaderCircle, Play, Video } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAppApiClient } from '../../app/use-api-client';
import type { ValidationFinding, ValidationResult, WorkspaceSnapshot } from '../../lib/course/types';

export type KnowledgeCodeBlock = {
  id: string;
  type: 'code';
  title?: string;
  caption?: string;
  language?: string;
  source?: string;
  content?: string;
  lineNumbers?: boolean;
};

export type KnowledgePdfBlock = {
  id: string;
  type: 'pdf';
  title?: string;
  caption?: string;
  asset: string;
  page?: number;
};

export type KnowledgeVideoBlock = {
  id: string;
  type: 'video';
  title?: string;
  caption?: string;
  provider: 'youtube' | 'bilibili';
  videoId?: string;
  playlistId?: string;
};

export type KnowledgeMediaBlock = KnowledgeCodeBlock | KnowledgePdfBlock | KnowledgeVideoBlock;

export function KnowledgeCodeBlockView({ block }: { block: KnowledgeCodeBlock }) {
  const api = useAppApiClient();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [validationState, setValidationState] = useState<'idle' | 'running' | 'passed' | 'failed'>('idle');
  const [validationMessage, setValidationMessage] = useState('');
  const code = block.content || '';
  const lines = useMemo(() => code.replace(/\r\n/g, '\n').split('\n'), [code]);
  const language = (block.language || 'text').toLowerCase();
  const canValidate = language === 'sysml' || language === 'sysmlv2';

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1800);
    } catch {
      setCopyState('failed');
    }
  };

  const validateCode = async () => {
    setValidationState('running');
    setValidationMessage('');
    const workspace: WorkspaceSnapshot = {
      entryFile: block.source || 'knowledge-example.sysml',
      activeFilePath: block.source || 'knowledge-example.sysml',
      files: [{ path: block.source || 'knowledge-example.sysml', content: code, editable: false, source: 'knowledge-pack' }]
    };
    try {
      const result = await api.request<ValidationResult>('/api/validate', { method: 'POST', body: workspace });
      const diagnostics = normalizeDiagnostics(result);
      if (isValidationPassed(result)) {
        setValidationState('passed');
        setValidationMessage('官方 Validator 未发现语法或语义错误。');
      } else {
        setValidationState('failed');
        setValidationMessage(firstDiagnostic(diagnostics) || 'Validator 未通过，请在建模工作台中进一步检查。');
      }
    } catch (error) {
      setValidationState('failed');
      setValidationMessage(error instanceof Error ? error.message : 'Validator 调用失败。');
    }
  };

  return (
    <div className="knowledgeCodeBlock" data-knowledge-code-block data-code-language={language}>
      <header className="knowledgeMediaHeader">
        <div><span className="knowledgeMediaIcon"><FileCode2 size={18} /></span><span><strong>{block.title || '代码示例'}</strong><small>{language}</small></span></div>
        <div className="knowledgeMediaActions">
          <button type="button" onClick={() => void copyCode()} aria-label="复制代码"><Clipboard size={15} />{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}</button>
          {canValidate ? <button type="button" onClick={() => void validateCode()} disabled={validationState === 'running'} aria-label="使用官方 Validator 检查代码">{validationState === 'running' ? <LoaderCircle className="isSpinning" size={15} /> : <CheckCircle2 size={15} />}检查</button> : null}
        </div>
      </header>
      <div className="knowledgeCodeViewport" tabIndex={0} aria-label={`${block.title || '代码示例'}，${lines.length} 行`}>
        <pre><code>{lines.map((line, index) => <span className="knowledgeCodeLine" key={`${index}-${line}`}><span aria-hidden="true">{block.lineNumbers === false ? '' : index + 1}</span><span>{line || ' '}</span></span>)}</code></pre>
      </div>
      {validationState !== 'idle' ? <div className={`knowledgeValidationResult is-${validationState}`} role="status">{validationState === 'running' ? <LoaderCircle className="isSpinning" size={16} /> : validationState === 'passed' ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}<span>{validationState === 'running' ? '正在调用官方 Validator…' : validationMessage}</span></div> : null}
      {block.caption ? <p className="knowledgeMediaCaption">{block.caption}</p> : null}
    </div>
  );
}

export function KnowledgePdfBlockView({ block, assetUrl }: { block: KnowledgePdfBlock; assetUrl: string }) {
  const [failed, setFailed] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const page = Math.max(1, Number(block.page) || 1);
  const viewerUrl = `${assetUrl}#page=${page}&view=FitH&toolbar=1&navpanes=0`;
  return (
    <div className="knowledgePdfBlock" data-knowledge-pdf-block>
      <header className="knowledgeMediaHeader">
        <div><span className="knowledgeMediaIcon"><FileText size={18} /></span><span><strong>{block.title || 'PDF 资料'}</strong><small>平台版本化资产</small></span></div>
        <div className="knowledgeMediaActions">
          <button type="button" onClick={() => setInteractive((current) => !current)} aria-pressed={interactive}>{interactive ? '锁定滚动' : '操作 PDF'}</button>
          <a href={assetUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />新窗口</a>
          <a href={assetUrl} download><Download size={15} />下载</a>
        </div>
      </header>
      {failed ? <div className="knowledgeMediaError" role="status"><CircleAlert size={20} /><strong>PDF 预览加载失败</strong><span>可使用“新窗口”或“下载”继续查看。</span></div> : <div className={`knowledgePdfViewport${interactive ? ' isInteractive' : ''}`}><iframe title={block.title || 'PDF 资料预览'} src={viewerUrl} loading="lazy" onError={() => setFailed(true)} /><span>{interactive ? 'PDF 交互已启用' : '预览模式 · 页面滚动优先'}</span></div>}
      {block.caption ? <p className="knowledgeMediaCaption">{block.caption}</p> : null}
    </div>
  );
}

export function KnowledgeVideoBlockView({ block }: { block: KnowledgeVideoBlock }) {
  const [consented, setConsented] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const source = videoSource(block);
  const providerLabel = block.provider === 'youtube' ? 'YouTube' : '哔哩哔哩';
  const loadVideo = () => {
    setFailed(false);
    setLoading(true);
    setConsented(true);
  };
  return (
    <div className="knowledgeVideoBlock" data-knowledge-video-block data-video-provider={block.provider}>
      <header className="knowledgeMediaHeader">
        <div><span className="knowledgeMediaIcon"><Video size={18} /></span><span><strong>{block.title || '外部视频'}</strong><small>{providerLabel}</small></span></div>
        <div className="knowledgeMediaActions"><a href={source.externalUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />在 {providerLabel} 打开</a></div>
      </header>
      {!consented ? (
        <div className="knowledgeVideoConsent">
          <span className="knowledgeVideoPlay"><Play size={25} fill="currentColor" /></span>
          <div><strong>按需加载外部视频</strong><p>平台不保存视频文件。点击后将连接 {providerLabel}，并受其隐私与可用性策略约束。</p></div>
          <button type="button" onClick={loadVideo}><Play size={16} fill="currentColor" />加载视频</button>
        </div>
      ) : failed ? (
        <div className="knowledgeMediaError" role="status"><CircleAlert size={20} /><strong>外部视频暂时不可用</strong><span>请稍后重试，或在 {providerLabel} 新窗口中打开。</span><button type="button" onClick={loadVideo}>重新加载</button></div>
      ) : (
        <div className="knowledgeVideoFrame">
          {loading ? <div className="knowledgeMediaLoading"><LoaderCircle className="isSpinning" size={22} />正在连接 {providerLabel}…</div> : null}
          <iframe
            title={block.title || `${providerLabel} 视频`}
            src={source.embedUrl}
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            onLoad={() => setLoading(false)}
            onError={() => { setLoading(false); setFailed(true); }}
          />
        </div>
      )}
      {block.caption ? <p className="knowledgeMediaCaption">{block.caption}</p> : null}
    </div>
  );
}

function videoSource(block: KnowledgeVideoBlock): { embedUrl: string; externalUrl: string } {
  if (block.provider === 'youtube') {
    if (block.playlistId) return {
      embedUrl: `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(block.playlistId)}`,
      externalUrl: `https://www.youtube.com/playlist?list=${encodeURIComponent(block.playlistId)}`
    };
    return {
      embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(block.videoId || '')}`,
      externalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(block.videoId || '')}`
    };
  }
  return {
    embedUrl: `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(block.videoId || '')}&page=1&high_quality=1&danmaku=0`,
    externalUrl: `https://www.bilibili.com/video/${encodeURIComponent(block.videoId || '')}`
  };
}

function normalizeDiagnostics(result: ValidationResult | null): ValidationFinding[] {
  if (!result) return [];
  if (Array.isArray(result.diagnostics)) return result.diagnostics;
  if (Array.isArray(result.findings)) return result.findings;
  return [];
}

function isValidationPassed(result: ValidationResult): boolean {
  if (typeof result.syntaxValid === 'boolean' || typeof result.semanticValid === 'boolean') return Boolean(result.syntaxValid) && Boolean(result.semanticValid);
  return Boolean(result.passed || result.ok) && normalizeDiagnostics(result).every((finding) => finding.severity !== 'error');
}

function firstDiagnostic(diagnostics: ValidationFinding[]): string {
  const finding = diagnostics.find((item) => item.severity === 'error') || diagnostics[0];
  if (!finding?.message) return '';
  return finding.line ? `第 ${finding.line} 行：${finding.message}` : finding.message;
}
