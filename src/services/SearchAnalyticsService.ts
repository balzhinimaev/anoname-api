import AnalyticsEvent from '../models/AnalyticsEvent';
import { TelegramNotificationService } from './TelegramNotificationService';
import { wsLogger } from '../utils/logger';

/**
 * Сквозная аналитика поиска: воронка старт→матч/отмена/обрыв/истёк,
 * время в поиске, поведение отмен, повторные поиски. Считается из durable
 * событий search_start / search_end (см. SearchService). Для текущего объёма
 * агрегируем в памяти; при кратном росте можно переехать на $aggregate/$bucket.
 */

type Num = number;
const avg = (a: Num[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a: Num[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const round = (n: number) => Math.round(n);

const DUR_BUCKETS = [
  { label: '<5с', max: 5_000 },
  { label: '5–15с', max: 15_000 },
  { label: '15–30с', max: 30_000 },
  { label: '30–60с', max: 60_000 },
  { label: '1–3м', max: 180_000 },
  { label: '>3м', max: Infinity },
];
function histogram(durations: Num[]) {
  const counts = DUR_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const d of durations) {
    const i = DUR_BUCKETS.findIndex((b) => d < b.max);
    counts[i === -1 ? counts.length - 1 : i].count++;
  }
  return counts;
}
function timingBlock(durations: Num[]) {
  return {
    count: durations.length,
    avgSec: round(avg(durations) / 1000),
    medianSec: round(pct(durations, 50) / 1000),
    p90Sec: round(pct(durations, 90) / 1000),
    histogram: histogram(durations),
  };
}

const dayKey = (d: Date) => new Date(d).toISOString().slice(0, 10);

export class SearchAnalyticsService {
  static async computeReport(sinceMs: number): Promise<any> {
    const since = new Date(Date.now() - sinceMs);
    const [starts, ends] = await Promise.all([
      AnalyticsEvent.find({ name: 'search_start', createdAt: { $gte: since } })
        .select('userId telegramId platform props.useGeolocation createdAt').lean(),
      AnalyticsEvent.find({ name: 'search_end', createdAt: { $gte: since } })
        .select('userId props.outcome props.reason props.durationMs props.useGeolocation platform createdAt').lean(),
    ]);

    const P = (e: any) => e.props || {};

    // ---- Тоталы ----
    const startsTotal = starts.length;
    const searchers = new Set(starts.map((e: any) => String(e.userId)));
    const uniqueSearchers = searchers.size;

    const by = { matched: 0, cancelled: 0, expired: 0 };
    const cancelReason = { user: 0, disconnect: 0, superseded: 0, other: 0 };
    const durMatched: number[] = [];
    const durCancelUser: number[] = [];
    for (const e of ends as any[]) {
      const o = P(e).outcome;
      if (o === 'matched') { by.matched++; if (typeof P(e).durationMs === 'number') durMatched.push(P(e).durationMs); }
      else if (o === 'expired') by.expired++;
      else if (o === 'cancelled') {
        by.cancelled++;
        const r = P(e).reason || 'other';
        (cancelReason as any)[r] = ((cancelReason as any)[r] || 0) + 1;
        if (r === 'user' && typeof P(e).durationMs === 'number') durCancelUser.push(P(e).durationMs);
      }
    }
    const matchRate = startsTotal ? by.matched / startsTotal : 0;
    const cancelRateUser = startsTotal ? cancelReason.user / startsTotal : 0;

    // ---- По юзерам ----
    const perUser = new Map<string, { starts: number; matched: number; cancels: number; telegramId?: string; platform?: string }>();
    for (const e of starts as any[]) {
      const k = String(e.userId);
      const u = perUser.get(k) || { starts: 0, matched: 0, cancels: 0, telegramId: e.telegramId, platform: e.platform };
      u.starts++; perUser.set(k, u);
    }
    for (const e of ends as any[]) {
      const k = String(e.userId);
      const u = perUser.get(k) || { starts: 0, matched: 0, cancels: 0 };
      if (P(e).outcome === 'matched') u.matched++;
      if (P(e).outcome === 'cancelled' && P(e).reason === 'user') u.cancels++;
      perUser.set(k, u);
    }
    const startsPerUserArr = [...perUser.values()].map((u) => u.starts).filter((n) => n > 0);
    const cancelsPerUserArr = [...perUser.values()].map((u) => u.cancels);
    // распределение поисков на юзера
    const spuBuckets = [{ label: '1', n: 0 }, { label: '2', n: 0 }, { label: '3–5', n: 0 }, { label: '6–10', n: 0 }, { label: '>10', n: 0 }];
    for (const n of startsPerUserArr) {
      if (n <= 1) spuBuckets[0].n++;
      else if (n === 2) spuBuckets[1].n++;
      else if (n <= 5) spuBuckets[2].n++;
      else if (n <= 10) spuBuckets[3].n++;
      else spuBuckets[4].n++;
    }
    const topSearchers = [...perUser.entries()]
      .map(([userId, u]) => ({ userId, telegramId: u.telegramId, platform: u.platform, ...u }))
      .sort((a, b) => b.starts - a.starts)
      .slice(0, 15);
    // повторный поиск после отмены: доля отменявших, кто искал снова
    const cancellers = [...perUser.values()].filter((u) => u.cancels > 0);
    const repeatedAfterCancel = cancellers.filter((u) => u.starts > u.cancels).length;
    const repeatRate = cancellers.length ? repeatedAfterCancel / cancellers.length : 0;

    // ---- По платформам ----
    const platMap = new Map<string, { starts: number; matched: number; cancelUser: number }>();
    for (const e of starts as any[]) {
      const p = e.platform || 'unknown';
      const m = platMap.get(p) || { starts: 0, matched: 0, cancelUser: 0 };
      m.starts++; platMap.set(p, m);
    }
    for (const e of ends as any[]) {
      const p = e.platform || 'unknown';
      const m = platMap.get(p) || { starts: 0, matched: 0, cancelUser: 0 };
      if (P(e).outcome === 'matched') m.matched++;
      if (P(e).outcome === 'cancelled' && P(e).reason === 'user') m.cancelUser++;
      platMap.set(p, m);
    }
    const byPlatform = [...platMap.entries()].map(([platform, m]) => ({
      platform, ...m, matchRate: m.starts ? m.matched / m.starts : 0,
    })).sort((a, b) => b.starts - a.starts);

    // ---- Гео вкл/выкл ----
    const geo = { on: { starts: 0, matched: 0 }, off: { starts: 0, matched: 0 } };
    for (const e of starts as any[]) (P(e).useGeolocation ? geo.on : geo.off).starts++;
    for (const e of ends as any[]) if (P(e).outcome === 'matched') (P(e).useGeolocation ? geo.on : geo.off).matched++;

    // ---- По дням ----
    const dayMap = new Map<string, { day: string; starts: number; matched: number; cancelUser: number; expired: number }>();
    const bump = (d: Date, f: 'starts' | 'matched' | 'cancelUser' | 'expired') => {
      const k = dayKey(d);
      const row = dayMap.get(k) || { day: k, starts: 0, matched: 0, cancelUser: 0, expired: 0 };
      row[f]++; dayMap.set(k, row);
    };
    for (const e of starts as any[]) bump(e.createdAt, 'starts');
    for (const e of ends as any[]) {
      if (P(e).outcome === 'matched') bump(e.createdAt, 'matched');
      else if (P(e).outcome === 'expired') bump(e.createdAt, 'expired');
      else if (P(e).outcome === 'cancelled' && P(e).reason === 'user') bump(e.createdAt, 'cancelUser');
    }
    const byDay = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

    return {
      period: { since: since.toISOString(), sinceMs },
      totals: {
        starts: startsTotal,
        uniqueSearchers,
        matched: by.matched,
        cancelled: by.cancelled,
        cancelUser: cancelReason.user,
        cancelDisconnect: cancelReason.disconnect,
        cancelSuperseded: cancelReason.superseded,
        expired: by.expired,
        matchRate,
        cancelRateUser,
      },
      timing: {
        toMatch: timingBlock(durMatched),
        toCancelUser: timingBlock(durCancelUser),
      },
      perUser: {
        avgSearchesPerUser: +avg(startsPerUserArr).toFixed(2),
        maxSearchesPerUser: startsPerUserArr.length ? Math.max(...startsPerUserArr) : 0,
        avgCancelsPerUser: +avg(cancelsPerUserArr).toFixed(2),
        searchesPerUserDist: spuBuckets,
        topSearchers,
        repeatAfterCancelRate: repeatRate,
      },
      byPlatform,
      byGeo: geo,
      byDay,
    };
  }

  /** Форматирует отчёт в текст Telegram-дайджеста (HTML). */
  static buildDigest(r: any, label: string): string {
    const t = r.totals;
    const sec = (s: number) => (s >= 60 ? Math.round(s / 6) / 10 + ' мин' : s + ' с');
    const rate = (n: number) => (n * 100).toFixed(1).replace('.0', '') + '%';
    const plats = (r.byPlatform || []).map((p: any) => `${p.platform} ${p.starts}`).join(' · ') || '—';
    const top = (r.perUser?.topSearchers || []).slice(0, 3)
      .map((u: any) => `${(u.userId || '').slice(-6)} (${u.starts})`).join(', ') || '—';
    const cm = r.timing?.toCancelUser || {}; const tm = r.timing?.toMatch || {};
    return [
      `📊 <b>Аналитика поиска · ${label}</b>`,
      ``,
      `🔎 Стартов: <b>${t.starts}</b> · уник. ${t.uniqueSearchers}`,
      `✅ Матчей: <b>${t.matched}</b> (${rate(t.matchRate)})`,
      `✋ Отмен вручную: <b>${t.cancelUser}</b>${cm.count ? ` · медиана ${sec(cm.medianSec)}` : ''}`,
      `🔌 Обрывов: ${t.cancelDisconnect} · ♻️ перебито: ${t.cancelSuperseded} · ⌛ истекло: ${t.expired}`,
      ``,
      `⏱ До матча: медиана ${sec(tm.medianSec)} · p90 ${sec(tm.p90Sec)}`,
      `👤 Поисков/юзера: ${r.perUser?.avgSearchesPerUser} (макс ${r.perUser?.maxSearchesPerUser}) · повтор после отмены ${rate(r.perUser?.repeatAfterCancelRate || 0)}`,
      `📱 Платформы: ${plats}`,
      ``,
      `🏆 Топ: ${top}`,
      ``,
      `📈 anoname.ru/admin/search-analytics.html`,
    ].join('\n');
  }

  /** Считает суточный отчёт и шлёт дайджест админу (пропускает пустые сутки). */
  static async sendDailyDigest(force = false): Promise<boolean> {
    try {
      const report = await this.computeReport(24 * 3600e3);
      if (!force && report.totals.starts === 0) return false;
      await TelegramNotificationService.sendCustomMessage(this.buildDigest(report, 'сутки'));
      return true;
    } catch (error) {
      wsLogger.warn('search_digest_failed', (error as Error).message);
      return false;
    }
  }
}

