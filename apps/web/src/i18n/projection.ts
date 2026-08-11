import { directionForLocale, type SupportedLocale } from './locale';

export interface LocaleProjectionTarget {
  documentElement: {
    lang: string;
    dir: string;
  };
  title: string;
}

export function applyLocaleProjection(
  locale: SupportedLocale,
  title: string,
  target: LocaleProjectionTarget = document
): void {
  target.documentElement.lang = locale;
  target.documentElement.dir = directionForLocale(locale);
  target.title = title;
}
