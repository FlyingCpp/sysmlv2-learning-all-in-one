import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  Blocks,
  BookOpen,
  Bot,
  ChevronLeft,
  ChevronRight,
  Code2,
  Compass,
  FileText,
  Layers3,
  Route,
  ShieldCheck,
  Sparkles,
  Wrench
} from 'lucide-react';
import { useRef } from 'react';
import { useCoursePackQuery, useCoursePacksQuery, useCoursesQuery } from '../../app/data-hooks';
import processRequirementIcon from '../../assets/home-process-icons/01-requirement.png';
import processStructureIcon from '../../assets/home-process-icons/02-structure.png';
import processBehaviorIcon from '../../assets/home-process-icons/03-behavior.png';
import processInterfaceIcon from '../../assets/home-process-icons/04-interface.png';
import processVerificationIcon from '../../assets/home-process-icons/05-verification.png';
import processSim1dIcon from '../../assets/home-process-icons/06-sim-1d.png';
import processSim3dIcon from '../../assets/home-process-icons/07-sim-3d.png';
import processTestIcon from '../../assets/home-process-icons/08-test.png';
import processElectronicsIcon from '../../assets/home-process-icons/09-electronics.png';
import processMdaoIcon from '../../assets/home-process-icons/10-mdao.png';
import { CoursePackCard } from '../shared/CoursePackCard';
import { ErrorState, LoadingState } from '../shared/ui';

const servicePaths = [
  {
    icon: Compass,
    index: '01',
    title: '工程知识库',
    body: '浏览已发布、可版本化维护的工程知识空间，按主题阅读文章、媒体、概念关系与来源证据。',
    note: '知识空间、主题目录、阅读进度与 AI 导读',
    to: '/knowledge' as const
  },
  {
    icon: Bot,
    index: '02',
    title: 'SysML v2 + AI 结合点',
    body: '在独立 AI 助手页面围绕课程、模型代码、诊断和 TODO 连续提问，获得可验证的建模建议。',
    note: '上下文辅助、诊断解释与补全建议',
    to: '/bench' as const
  },
  {
    icon: Code2,
    index: '03',
    title: 'SysML v2 语言与练习',
    body: '按课程顺序阅读概念，并在 Lesson Workbench 完成 TODO、官方兼容校验与课程规则反馈。',
    note: '课程地图、建模练习与校验闭环',
    to: '/course-shelf' as const
  },
  {
    icon: Blocks,
    index: '04',
    title: 'SysML v2 工程应用',
    body: '进入工程应用案例，用 SysML v2 模型开展架构语义抽取、工程分析、指标比较和结果验证。',
    note: '真实案例、分析指标与工程验证',
    to: '/apps' as const
  }
];

const learningSteps = [
  ['建立认知', '理解系统工程与 SysML v2 的关系，知道模型为什么服务工程决策。'],
  ['掌握语法', '从 package、part、port、action、state、requirement 到 view 逐步练习。'],
  ['完成校验', '用官方兼容校验、课程规则和诊断解释闭合语法与语义问题。'],
  ['进入应用', '把需求、结构、行为、接口、分析和验证放进真实工程链路。'],
  ['结合 AI', '在模型生成、错误解释和知识检索中使用 AI，同时保留工程验证。']
];

const introSignals = [
  { icon: Compass, title: '系统工程方法' },
  { icon: Code2, title: 'SysML v2 练习' },
  { icon: Blocks, title: '工程应用案例' },
  { icon: Bot, title: 'AI 建模辅助' }
];

const resources = [
  {
    icon: BookOpen,
    title: '课程书架',
    body: '按课程包组织 SysML v2 学习路径，适合从基础语法到工程案例逐步推进。',
    to: '/course-shelf',
    action: '打开书架'
  },
  {
    icon: Wrench,
    title: '建模工作台',
    body: '自由编辑 SysML v2 模型，查看模型结构、运行校验，并导出建模结果。',
    to: '/bench',
    action: '打开工作台'
  },
  {
    icon: ShieldCheck,
    title: '校验与诊断',
    body: '把官方语法语义校验、课程规则、错误定位和解释卡片放在同一学习闭环里。',
    to: '/courses',
    action: '查看练习'
  },
  {
    icon: FileText,
    title: '术语表与知识库',
    body: '维护 SysML v2 元模型术语、概念关系和学习过程中的关键工程词汇。',
    to: '/glossary',
    action: '查术语'
  },
  {
    icon: Sparkles,
    title: 'AI 建模辅助',
    body: '围绕诊断解释、模型片段建议和工程知识检索，辅助学习者形成下一步动作。',
    to: '/bench',
    action: '进入试验台'
  },
  {
    icon: Route,
    title: '系统工程教程',
    body: '规划中的方法论模块，将覆盖需求分析、架构分解、验证规划和工程评审。',
    action: '规划中'
  }
];

export function HomePage() {
  return (
    <div className="homePage" data-home-page>
      <section className="homeIntroHero" aria-labelledby="homeIntroTitle">
        <div className="homeIntroCopy">
          <h1 id="homeIntroTitle">研发领域驾驭 AI 的关键，是系统工程方法与精准的系统建模语言</h1>
          <p>
            面向系统工程师、MBSE 实践者和 SysML v2 学习者的建模平台。这里不仅是课程书架，
            也是学习系统工程方法、练习 SysML v2、理解工程应用和探索 AI 建模辅助的入口。
          </p>
          <div className="homeIntroActions" aria-label="首页主要入口">
            <Link className="primaryLink" to="/knowledge">
              打开 SysML v2 知识助手
              <ArrowRight size={17} />
            </Link>
            <Link className="secondaryLink" to="/bench">
              进入 AI 辅助自由练习
              <ArrowRight size={17} />
            </Link>
            <Link className="secondaryLink" to="/course-shelf">
              打开课程书架
              <ArrowRight size={17} />
            </Link>
          </div>
          <div className="homeIntroSignals" aria-label="平台能力摘要">
            {introSignals.map((signal) => {
              const Icon = signal.icon;
              return (
                <div className="homeIntroSignal" key={signal.title}>
                  <span className="homeIntroSignalLogo" aria-hidden="true">
                    <Icon size={20} />
                  </span>
                  <strong>{signal.title}</strong>
                </div>
              );
            })}
          </div>
        </div>
        <div className="homeEngineeringAnimation" aria-label="从系统架构模型到产品实现与仿真的工程建模动画">
          <svg className="engineeringProcessScene" viewBox="0 0 860 520" role="img" aria-labelledby="engineeringProcessTitle engineeringProcessDesc">
            <title id="engineeringProcessTitle">系统架构模型与产品实现及仿真联动</title>
            <desc id="engineeringProcessDesc">左侧系统架构模型包含 requirement、behavior、structure、interface 和 verification；右侧产品实现与仿真包含 1D 仿真、3D 仿真、控制电子、试验测试和多学科优化；中间通过需求约束和优化反馈双向贯通。</desc>
            <defs>
              <linearGradient id="processFlowGradient" x1="70" x2="790" y1="0" y2="0" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#d8c8a4" />
                <stop offset="0.52" stopColor="#c9b27e" />
                <stop offset="1" stopColor="#64748b" />
              </linearGradient>
              <radialGradient id="architectureCoreGradient" cx="50%" cy="46%" r="68%">
                <stop offset="0" stopColor="#ffffff" />
                <stop offset="0.58" stopColor="#f4ead6" />
                <stop offset="1" stopColor="#d8c8a4" />
              </radialGradient>
              <radialGradient id="analysisCoreGradient" cx="50%" cy="46%" r="68%">
                <stop offset="0" stopColor="#ffffff" />
                <stop offset="0.58" stopColor="#f1f5f9" />
                <stop offset="1" stopColor="#64748b" />
              </radialGradient>
              <marker id="processArrowBlue" markerHeight="14" markerUnits="userSpaceOnUse" markerWidth="14" orient="auto" refX="11" refY="7" viewBox="0 0 14 14">
                <path d="M2 2 12 7 2 12Z" fill="#d8c8a4" />
              </marker>
              <marker id="processArrowGreen" markerHeight="14" markerUnits="userSpaceOnUse" markerWidth="14" orient="auto" refX="11" refY="7" viewBox="0 0 14 14">
                <path d="M2 2 12 7 2 12Z" fill="#94a3b8" />
              </marker>
              <filter id="processGlow" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="8" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <rect className="processGrid" x="22" y="22" width="816" height="476" rx="22" />
            <g className="engineeringProcessContent" transform="translate(0 -28)">
            <path id="architectureLoopPath" className="loopGuide architectureGuide" d="M366 140 C292 72 150 92 102 208 C52 330 154 438 276 416 C358 402 418 326 410 246" />
            <path id="analysisLoopPath" className="loopGuide analysisGuide" d="M494 140 C568 72 710 92 758 208 C808 330 706 438 584 416 C502 402 442 326 450 246" />
            <path className="loopRibbon architectureRibbon" markerEnd="url(#processArrowBlue)" d="M342 136 C270 86 156 106 112 202" />
            <path className="loopRibbon architectureRibbon architectureReturn" markerEnd="url(#processArrowBlue)" d="M116 326 C168 422 310 430 382 342" />
            <path className="loopRibbon analysisRibbon" markerEnd="url(#processArrowGreen)" d="M518 136 C590 86 704 106 748 202" />
            <path className="loopRibbon analysisRibbon analysisReturn" markerEnd="url(#processArrowGreen)" d="M744 326 C692 422 550 430 478 342" />
            <circle className="processParticle architectureParticle" r="7">
              <animateMotion dur="7.5s" repeatCount="indefinite" rotate="auto">
                <mpath href="#architectureLoopPath" />
              </animateMotion>
            </circle>
            <circle className="processParticle analysisParticle" r="7">
              <animateMotion dur="8.5s" repeatCount="indefinite" rotate="auto">
                <mpath href="#analysisLoopPath" />
              </animateMotion>
            </circle>
            <g className="exchangeFlow">
              <g className="binaryStream" aria-hidden="true">
                <text className="binaryOne" x="386" y="246">0101</text>
                <text className="binaryTwo" x="430" y="262">1010</text>
                <text className="binaryThree" x="474" y="282">0110</text>
                <text className="binaryFour" x="416" y="306">1001</text>
              </g>
            </g>
            <g className="architectureCore">
              <circle cx="250" cy="260" r="92" />
              <circle cx="250" cy="260" r="58" />
              <path d="M250 190 310 225v70l-60 35-60-35v-70l60-35Z" />
              <text x="250" y="250">系统架构模型</text>
              <text x="250" y="278">Requirements · Behavior · Structure</text>
            </g>
            <g className="analysisCore">
              <circle cx="610" cy="260" r="92" />
              <circle cx="610" cy="260" r="58" />
              <path d="M560 260c22-48 78-62 118-28M540 298c48 26 112 12 140-38M570 214l-30 84M650 204l-18 112" />
              <text x="610" y="250">产品实现与仿真</text>
              <text x="610" y="278">1D · 3D · Test · Optimization</text>
            </g>
            <g className="architectureNodes">
              <g className="loopNode nodeRequirement" transform="translate(112 152)">
                <image className="processNodeIcon" href={processRequirementIcon} x="-48" y="-48" width="96" height="96" preserveAspectRatio="xMidYMid meet" />
                <text y="66">Requirement</text>
                <text y="84">需求</text>
              </g>
              <g className="loopNode nodeBehavior" transform="translate(120 326)">
                <image className="processNodeIcon" href={processBehaviorIcon} x="-48" y="-48" width="96" height="96" preserveAspectRatio="xMidYMid meet" />
                <text y="66">Behavior</text>
                <text y="84">行为</text>
              </g>
              <g className="loopNode nodeStructure" transform="translate(250 98)">
                <image className="processNodeIcon" href={processStructureIcon} x="-48" y="-48" width="96" height="96" preserveAspectRatio="xMidYMid meet" />
                <text y="66">Structure</text>
                <text y="84">结构</text>
              </g>
              <g className="loopNode nodeInterface" transform="translate(382 128)">
                <image className="processNodeIcon" href={processInterfaceIcon} x="-48" y="-48" width="96" height="96" preserveAspectRatio="xMidYMid meet" />
                <text y="66">Interface</text>
                <text y="84">接口</text>
              </g>
              <g className="loopNode nodeVerification" transform="translate(274 424)">
                <image className="processNodeIcon" href={processVerificationIcon} x="-48" y="-48" width="96" height="96" preserveAspectRatio="xMidYMid meet" />
                <text y="66">Verification</text>
                <text y="84">验证</text>
              </g>
            </g>
            <g className="analysisNodes">
              <g className="loopNode nodeSim1d" transform="translate(510 114)">
                <image className="processNodeIcon" href={processSim1dIcon} x="-48" y="-48" width="96" height="96" preserveAspectRatio="xMidYMid meet" />
                <text y="66">1D 仿真</text>
                <text y="84">系统行为</text>
              </g>
              <g className="loopNode nodeSim3d" transform="translate(716 152)">
                <image className="processNodeIcon" href={processSim3dIcon} x="-48" y="-48" width="96" height="96" preserveAspectRatio="xMidYMid meet" />
                <text y="66">3D 仿真</text>
                <text y="84">几何/场</text>
              </g>
              <g className="loopNode nodeElectronics" transform="translate(744 326)">
                <image className="processNodeIcon" href={processElectronicsIcon} x="-48" y="-48" width="96" height="96" preserveAspectRatio="xMidYMid meet" />
                <text y="66">控制电子</text>
                <text y="84">软件/硬件</text>
              </g>
              <g className="loopNode nodeTest" transform="translate(604 424)">
                <image className="processNodeIcon" href={processTestIcon} x="-48" y="-48" width="96" height="96" preserveAspectRatio="xMidYMid meet" />
                <text y="66">试验测试</text>
                <text y="84">证据闭环</text>
              </g>
              <g className="loopNode nodeMdao" transform="translate(486 326)">
                <image className="processNodeIcon" href={processMdaoIcon} x="-48" y="-48" width="96" height="96" preserveAspectRatio="xMidYMid meet" />
                <text y="66">多学科优化</text>
                <text y="84">性能/成本</text>
              </g>
            </g>
            </g>
          </svg>
        </div>
      </section>

      <section className="homeServiceSection" aria-labelledby="homeServiceTitle">
        <div className="homeSectionHeading">
          <h2 id="homeServiceTitle">学习要点</h2>
          <p>新用户可以先按目标选择入口，再进入课程、工作台或术语资源。</p>
        </div>
        <div className="homeServiceGrid">
          {servicePaths.map((item) => {
            const Icon = item.icon;
            const serviceRoute = 'to' in item ? item.to : undefined;
            return (
              <article className={`homeServiceCard${serviceRoute ? ' isLinked' : ''}`} key={item.title}>
                <Icon size={32} aria-hidden="true" />
                <span>{item.index}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                <small>{item.note}</small>
                {serviceRoute ? <Link className="homeServiceCardLink" to={serviceRoute}>开始阅读<ArrowRight size={15} /></Link> : null}
              </article>
            );
          })}
        </div>
      </section>

      <section className="homeJourneySection" aria-labelledby="homeJourneyTitle">
        <div className="homeSectionHeading">
          <h2 id="homeJourneyTitle">从理解到工程实践</h2>
          <p>站点按“方法认知、语言练习、验证反馈、工程落地、AI 辅助”组织学习节奏。</p>
        </div>
        <div className="homePracticeAnimation" aria-label="一步一步完成建模实践的动画">
          <div className="practiceTrack" aria-hidden="true">
            {learningSteps.map(([title], index) => (
              <span key={title} data-step={index + 1} />
            ))}
          </div>
          <ol className="homeJourneyList">
            {learningSteps.map(([title, body], index) => (
              <li key={title}>
                <span>{index + 1}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="homeResourceSection" aria-labelledby="homeResourceTitle">
        <div className="homeSectionHeading">
          <h2 id="homeResourceTitle">平台功能介绍</h2>
          <p>平台把课程书架、建模工作台、校验诊断、术语知识库、示例和 AI 辅助组织成一个学习与工程实践环境。</p>
        </div>
        <div className="homeResourceGrid">
          {resources.map((item) => {
            const Icon = item.icon;
            const content = (
              <>
                <Icon size={28} aria-hidden="true" />
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                <span>{item.action}</span>
              </>
            );
            return item.to ? (
              <Link className="homeResourceCard" key={item.title} to={item.to}>
                {content}
              </Link>
            ) : (
              <article className="homeResourceCard isMuted" key={item.title}>
                {content}
              </article>
            );
          })}
        </div>
      </section>

      <section className="homeClosingCta" aria-labelledby="homeClosingTitle">
        <h2 id="homeClosingTitle">从现在开始，理解系统工程建模平台能做什么</h2>
        <p>先浏览课程书架建立学习路径，或进入建模试验台动手实践。</p>
        <div className="homeIntroActions">
          <Link className="primaryLink" to="/course-shelf">打开课程书架</Link>
          <Link className="secondaryLink" to="/bench">进入 AI 辅助自由练习</Link>
        </div>
      </section>
    </div>
  );
}

export function CourseShelfPage() {
  const galleryRef = useRef<HTMLDivElement | null>(null);
  const packQuery = useCoursePackQuery();
  const packsQuery = useCoursePacksQuery();
  const coursesQuery = useCoursesQuery();
  const pack = packQuery.data;
  const courses = coursesQuery.data || [];
  const enabledPacks = (packsQuery.data?.packs || []).filter((packItem) => packItem.enabled !== false);
  const galleryCanOverflow = enabledPacks.length > 3;
  const scrollCoursePackGallery = (direction: -1 | 1) => {
    const gallery = galleryRef.current;
    const firstCard = gallery?.querySelector<HTMLElement>('.coursePackGalleryCard');
    if (!gallery || !firstCard) return;
    const gap = Number.parseFloat(window.getComputedStyle(gallery).columnGap || '0') || 0;
    gallery.scrollBy({
      left: direction * (firstCard.getBoundingClientRect().width + gap),
      behavior: 'smooth'
    });
  };

  if (packQuery.isLoading) return <LoadingState label="正在加载课程" />;
  if (packQuery.error) return <ErrorState error={packQuery.error} />;

  return (
    <div className="homePage courseShelfPage" data-course-shelf-page>
      {enabledPacks.length ? (
        <section className="coursePackGalleryShell" aria-label="已启用课程包">
          <div className="galleryHeader">
            <div>
              <span className="missionEyebrow">当前课程书架</span>
              <h3>选择要深入学习的课程内容</h3>
            </div>
            <div className="galleryHeaderActions">
              <small>更多课程点击展示窗</small>
              {galleryCanOverflow ? (
                <div className="coursePackGalleryNav" aria-label="课程包横向滑动">
                  <button
                    type="button"
                    aria-label="向左滑动课程包"
                    onClick={() => scrollCoursePackGallery(-1)}
                  >
                    <ChevronLeft size={17} />
                  </button>
                  <button
                    type="button"
                    aria-label="向右滑动课程包"
                    onClick={() => scrollCoursePackGallery(1)}
                  >
                    <ChevronRight size={17} />
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <div className="coursePackGallery" ref={galleryRef} tabIndex={0}>
            {enabledPacks.map((packItem) => (
              <CoursePackCard
                key={packItem.id}
                pack={packItem}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="homeHero">
        <div className="homeHeroCopy">
          <span className="missionEyebrow">当前学习路径</span>
          <h2>{pack?.title || '课程包未加载'}</h2>
          <p>{pack?.description || '通过工程案例学习可校验的 SysML v2 建模方法。'}</p>
          <div className="homeHeroMeta">
            <span>SysML {pack?.sysmlVersion || '2.0'}</span>
            <span>{pack?.language || 'zh-CN'}</span>
            <span>{courses.length} 个 Course</span>
          </div>
          <div className="homeHeroActions">
            <Link className="primaryLink" to="/courses">
              <BookOpen size={17} />
              进入当前课程
            </Link>
            <Link className="secondaryLink" to="/bench">
              <Layers3 size={17} />
              自由建模练习
            </Link>
          </div>
        </div>
        <div className="homeHeroVisual" aria-label="当前课程能力摘要">
          <div className="coursePathVisual">
            <div>
              <span>Method</span>
              <strong>系统工程</strong>
            </div>
            <div>
              <span>Language</span>
              <strong>SysML v2</strong>
            </div>
            <div>
              <span>Practice</span>
              <strong>工程练习</strong>
            </div>
            <div>
              <span>Evidence</span>
              <strong>验证闭环</strong>
            </div>
          </div>
          <div>
            <h3>{pack?.homeVisual?.title || '课程工程视图'}</h3>
            <p>{pack?.homeVisual?.caption || '从课程包进入具体工程案例，用模型、校验和解释卡片完成学习闭环。'}</p>
          </div>
        </div>
      </section>

    </div>
  );
}
