import { useTranslation } from 'react-i18next';

type Phase0RouteContentProps = {
  eyebrow: string;
  title: string;
  description: string;
};

export function Phase0RouteContent({ eyebrow, title, description }: Phase0RouteContentProps) {
  const { t } = useTranslation('shell');
  return (
    <section className="phase0Hero" data-react-phase0-shell>
      <span className="phase0Eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      <p>{description}</p>
      <div className="phase0Checklist" aria-label={t('phase0.gatesAria')}>
        <span>build:web</span>
        <span>typecheck:web</span>
        <span>test:web</span>
        <span>Docker served assets</span>
      </div>
    </section>
  );
}
