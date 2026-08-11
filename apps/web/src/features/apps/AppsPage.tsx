import { AlertCircle, Blocks, ExternalLink, PanelLeftClose, PanelLeftOpen, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAppsQuery } from '../../app/data-hooks';
import type { PlatformAppManifest } from '../../lib/course/types';
import { ErrorState, SilentLoadingState } from '../shared/ui';
import { OpenCarNativePage } from './opencar-native/OpenCarNativePage';
import { OPEN_CAR_ANALYSIS, type OpenCarCaseId } from './opencar-native/opencar-data';

export function AppsPage() {
  const appsQuery = useAppsQuery();
  const apps = useMemo(() => (appsQuery.data?.apps || []).filter((app) => app.enabled !== false), [appsQuery.data]);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [railCollapsed, setRailCollapsed] = useState(false);

  useEffect(() => {
    if (!apps.length) {
      setSelectedAppId('');
      return;
    }
    const preferred = appsQuery.data?.activeAppId && apps.some((app) => app.id === appsQuery.data?.activeAppId)
      ? appsQuery.data.activeAppId
      : apps[0].id;
    setSelectedAppId((current) => apps.some((app) => app.id === current) ? current : preferred);
  }, [apps, appsQuery.data?.activeAppId]);

  const selectedApp = apps.find((app) => app.id === selectedAppId) || apps[0] || null;

  if (appsQuery.isLoading) return <SilentLoadingState />;
  if (appsQuery.error) return <ErrorState error={appsQuery.error} />;

  return (
    <section className="appsPage" data-apps-page data-apps-rail-collapsed={railCollapsed ? 'true' : 'false'} aria-label="Apps">
      {railCollapsed ? (
        <button
          type="button"
          className="appsRailFloatingToggle"
          data-apps-rail-floating-toggle
          aria-label="展开 Apps 侧边栏"
          aria-expanded="false"
          onClick={() => setRailCollapsed(false)}
        >
          <PanelLeftOpen size={18} />
        </button>
      ) : (
        <aside className="appsRail" data-apps-sidebar aria-label="已启用 Apps">
          <header className="appsRailHeader">
            <button
              type="button"
              className="appsRailToggle"
              data-apps-rail-toggle
              aria-label="收起 Apps 侧边栏"
              aria-expanded="true"
              onClick={() => setRailCollapsed(true)}
            >
              <PanelLeftClose size={17} />
            </button>
            <span className="appsRailHeaderLabel">Apps</span>
          </header>
          <div className="appsRailList" role="list">
            {apps.map((app) => (
              <button
                key={app.id}
                type="button"
                className="appRailItem"
                data-app-nav-item={app.id}
                aria-label={app.name}
                aria-current={selectedApp?.id === app.id ? 'page' : undefined}
                title={app.name}
                onClick={() => setSelectedAppId(app.id)}
              >
                <AppLogo app={app} />
                <span className="appRailTooltip" role="tooltip">
                  <strong>{app.name}</strong>
                  <small>{app.category || app.runtime.type}</small>
                </span>
              </button>
            ))}
          </div>
        </aside>
      )}

      <main className="appsHost" data-app-host>
        {selectedApp ? <AppHost app={selectedApp} /> : <EmptyAppsState />}
      </main>
    </section>
  );
}

function AppHost({ app }: { app: PlatformAppManifest }) {
  const [frameKey, setFrameKey] = useState(0);
  const [openCarCase, setOpenCarCase] = useState<OpenCarCaseId>('zonal');
  if (app.id === 'opencar' && app.runtime.type === 'native-react') {
    const compareDelta = {
      lengthM: OPEN_CAR_ANALYSIS.domain.summary.lengthM - OPEN_CAR_ANALYSIS.zonal.summary.lengthM,
      massKg: OPEN_CAR_ANALYSIS.domain.summary.massKg - OPEN_CAR_ANALYSIS.zonal.summary.massKg
    };
    return (
      <>
        <header className="appsHostHeader appsHostHeaderCompact" data-app-host-header>
          <div className="appsHostTitle">
            <AppLogo app={app} />
            <div>
              <h2>{app.name}</h2>
              <p>基于 SysML v2 模型的 E/E 架构语义抽取、工程结算与论文端点复现。</p>
            </div>
          </div>
          <div className="appsHostMetrics" aria-label="OpenCar 关键指标">
            <HostMetric label="当前案例" value={openCarCase === 'zonal' ? 'Zonal' : 'Domain'} />
            <HostMetric label="Zonal 长度" value={`${formatHostNumber(OPEN_CAR_ANALYSIS.zonal.summary.lengthM, 3)} m`} />
            <HostMetric label="Domain 长度" value={`${formatHostNumber(OPEN_CAR_ANALYSIS.domain.summary.lengthM, 2)} m`} />
            <HostMetric label="长度差" value={`${formatHostSigned(compareDelta.lengthM, 3)} m`} />
            <HostMetric label="质量差" value={`${formatHostSigned(compareDelta.massKg, 3)} kg`} />
          </div>
        </header>
        <OpenCarNativePage activeCase={openCarCase} onActiveCaseChange={setOpenCarCase} />
      </>
    );
  }
  return (
    <>
      <header className="appsHostHeader" data-app-host-header>
        <div className="appsHostTitle">
          <AppLogo app={app} />
          <div>
            <span className="missionEyebrow">{app.runtime.type}</span>
            <h2>{app.name}</h2>
            {app.description ? <p>{app.description}</p> : null}
          </div>
        </div>
        <div className="appsHostActions">
          <button type="button" onClick={() => setFrameKey((value) => value + 1)} aria-label="刷新 App">
            <RefreshCw size={16} />
          </button>
          <a href={app.runtime.entryUrl} target="_blank" rel="noreferrer" aria-label="在新窗口打开 App">
            <ExternalLink size={16} />
          </a>
        </div>
      </header>
      <iframe
        key={`${app.id}-${frameKey}`}
        className="appsFrame"
        data-app-frame={app.id}
        title={app.name}
        src={app.runtime.entryUrl}
        sandbox={app.runtime.sandbox || 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'}
        referrerPolicy="same-origin"
      />
    </>
  );
}

function AppLogo({ app }: { app: PlatformAppManifest }) {
  return (
    <span className="appLogo" aria-hidden="true">
      {app.logo ? <img src={app.logo} alt="" /> : <Blocks size={20} />}
    </span>
  );
}

function HostMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="appsHostMetric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatHostNumber(value: number, digits = 3) {
  return Number(value.toFixed(digits)).toString();
}

function formatHostSigned(value: number, digits = 3) {
  const formatted = formatHostNumber(value, digits);
  return value >= 0 ? `+${formatted}` : formatted;
}

function EmptyAppsState() {
  return (
    <div className="appsEmptyState" data-apps-empty-state>
      <AlertCircle size={24} />
      <h2>暂无启用 App</h2>
      <p>安装或启用 App 资源包后，会在左侧列表中显示，并在这里加载独立工作区。</p>
    </div>
  );
}
