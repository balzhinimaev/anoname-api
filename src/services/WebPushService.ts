/**
 * Web Push: доставка браузерных уведомлений веб-пользователям (VAPID).
 * Это единственный канал возврата для web/vk-аудитории (в Telegram их нет).
 * @module services/WebPushService
 */

import webpush from 'web-push';
import mongoose from 'mongoose';
import PushSubscription from '../models/PushSubscription';
import User from '../models/User';
import AnalyticsEvent from '../models/AnalyticsEvent';
import logger from '../utils/logger';

export interface PushPayload {
  title: string;
  body: string;
  /** Куда ведёт клик по уведомлению (относительный URL приложения) */
  url?: string;
  /** Схлопывание одинаковых уведомлений */
  tag?: string;
}

/**
 * Серия реактивации: после N часов неактивности — пуш соответствующей ступени.
 * Ступень сбрасывается, когда пользователь снова был активен после последнего пуша.
 */
const REENGAGEMENT_STAGES: Array<{ afterHours: number; payload: PushPayload }> = [
  {
    afterHours: 24,
    payload: {
      title: 'Тебя ждут в Anoname 💬',
      body: 'Новые собеседники уже онлайн. Поиск занимает меньше минуты.',
      url: '/app/?utm_source=push&utm_campaign=re1',
      tag: 'reengage'
    }
  },
  {
    afterHours: 72,
    payload: {
      title: 'Вечером здесь больше всего людей 🌙',
      body: 'Загляни после 20:00 — найти собеседника проще всего в час пик.',
      url: '/app/?utm_source=push&utm_campaign=re2',
      tag: 'reengage'
    }
  },
  {
    afterHours: 168,
    payload: {
      title: 'Мы скучаем 🙌',
      body: 'Анонимный чат никуда не делся. Возвращайся — без анкет и телефона.',
      url: '/app/?utm_source=push&utm_campaign=re3',
      tag: 'reengage'
    }
  }
];

export class WebPushService {
  private static configured = false;
  private static jobStarted = false;

  /** Готов ли сервис слать пуши (VAPID-ключи заданы). */
  static get enabled(): boolean {
    return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  }

  static get publicKey(): string {
    return process.env.VAPID_PUBLIC_KEY || '';
  }

  private static ensureConfigured(): boolean {
    if (!this.enabled) return false;
    if (!this.configured) {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@anoname.ru',
        process.env.VAPID_PUBLIC_KEY as string,
        process.env.VAPID_PRIVATE_KEY as string
      );
      this.configured = true;
    }
    return true;
  }

  /** Сохраняет подписку браузера (идемпотентно по endpoint). */
  static async subscribe(userId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent?: string): Promise<boolean> {
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return false;
    if (subscription.endpoint.length > 1024) return false;
    await PushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      {
        userId: new mongoose.Types.ObjectId(userId),
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
        userAgent: (userAgent || '').slice(0, 256)
      },
      { upsert: true }
    );
    try { void AnalyticsEvent.create({ userId: new mongoose.Types.ObjectId(userId), name: 'push_subscribed' } as any).catch(() => {}); } catch { /* noop */ }
    return true;
  }

  static async unsubscribe(userId: string, endpoint: string): Promise<void> {
    if (!endpoint) return;
    await PushSubscription.deleteOne({ endpoint, userId: new mongoose.Types.ObjectId(userId) });
  }

  /**
   * Шлёт пуш во все подписки пользователя. Мёртвые подписки (404/410) удаляет.
   * Возвращает число успешных доставок в пуш-сервис.
   */
  static async sendToUser(userId: string, payload: PushPayload): Promise<number> {
    if (!this.ensureConfigured()) return 0;
    const subs = await PushSubscription.find({ userId: new mongoose.Types.ObjectId(userId) }).lean();
    let delivered = 0;
    for (const sub of subs) {
      delivered += await this.sendToSubscription(sub, payload) ? 1 : 0;
    }
    return delivered;
  }

  private static async sendToSubscription(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: PushPayload): Promise<boolean> {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify(payload),
        { TTL: 12 * 60 * 60 }
      );
      return true;
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        // Подписка протухла (браузер отозвал) — чистим
        await PushSubscription.deleteOne({ endpoint: sub.endpoint }).catch(() => {});
      } else {
        logger.warn('web_push_send_failed', { statusCode, error: (error as Error)?.message });
      }
      return false;
    }
  }

  /**
   * Джоб реактивации: раз в час выбирает подписанных пользователей,
   * неактивных дольше порога очередной ступени, и шлёт пуш серии D1/D3/D7.
   * Состояние серии — в User.pushReengagement {stage, lastAt}; серия
   * сбрасывается, когда пользователь был активен после последнего пуша.
   */
  static startReengagementJob(): void {
    if (this.jobStarted || !this.enabled) {
      if (!this.enabled) logger.warn('web_push_disabled', { reason: 'VAPID keys are not configured' });
      return;
    }
    this.jobStarted = true;
    const run = () => this.runReengagementPass().catch((e) => logger.error('push_reengagement_job_error', { error: (e as Error)?.message }));
    setInterval(run, 60 * 60 * 1000).unref?.();
    // Первый прогон — через 5 минут после старта (даём приложению прогреться)
    setTimeout(run, 5 * 60 * 1000).unref?.();
  }

  private static async runReengagementPass(): Promise<void> {
    if (!this.ensureConfigured()) return;
    const now = Date.now();
    const minInactiveMs = REENGAGEMENT_STAGES[0].afterHours * 3600_000;

    // Кандидаты: есть подписка, неактивен дольше минимального порога
    const userIds = await PushSubscription.distinct('userId');
    if (userIds.length === 0) return;
    const users = await User.find({
      _id: { $in: userIds },
      lastActive: { $lte: new Date(now - minInactiveMs) }
    }).select('lastActive pushReengagement').lean();

    let sent = 0;
    for (const u of users as Array<{ _id: mongoose.Types.ObjectId; lastActive?: Date; pushReengagement?: { stage: number; lastAt: Date } }>) {
      const lastActive = u.lastActive ? u.lastActive.getTime() : 0;
      const re = u.pushReengagement;
      // Был активен после последнего пуша → серия начинается заново
      const stage = re && re.lastAt && re.lastAt.getTime() > lastActive ? re.stage : 0;
      if (stage >= REENGAGEMENT_STAGES.length) continue; // серия исчерпана
      const def = REENGAGEMENT_STAGES[stage];
      if (now - lastActive < def.afterHours * 3600_000) continue; // порог ступени ещё не наступил
      // Антидребезг: между пушами серии — не чаще раза в 20 часов
      if (re?.lastAt && now - re.lastAt.getTime() < 20 * 3600_000) continue;

      const delivered = await this.sendToUser(String(u._id), def.payload);
      await User.updateOne(
        { _id: u._id },
        { pushReengagement: { stage: stage + 1, lastAt: new Date(now) } }
      );
      if (delivered > 0) {
        sent++;
        try { void AnalyticsEvent.create({ userId: u._id, name: 'push_reengagement_sent', props: { stage: stage + 1 } } as any).catch(() => {}); } catch { /* noop */ }
      }
    }
    if (sent > 0) {
      logger.info('push_reengagement_pass', { candidates: users.length, sent });
    }
  }
}

export default WebPushService;
