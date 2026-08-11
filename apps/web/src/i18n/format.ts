import type { SupportedLocale } from './locale';

export function formatDate(
  value: Date | number | string,
  locale: SupportedLocale,
  options: Intl.DateTimeFormatOptions = {}
): string {
  return new Intl.DateTimeFormat(locale, options).format(toDate(value));
}

export function formatDateTime(value: Date | number | string, locale: SupportedLocale): string {
  return formatDate(value, locale, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

export function formatNumber(
  value: number,
  locale: SupportedLocale,
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatPercent(value: number, locale: SupportedLocale): string {
  return formatNumber(value, locale, { style: 'percent' });
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale: SupportedLocale
): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit);
}

function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}
