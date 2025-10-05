import { randomUUID } from 'crypto';
import Redis from 'ioredis';

import config from '../config';
import LeadBroadcastLog, {
  ILeadBroadcastLog,
  LeadBroadcastMethod,
} from '../models/LeadBroadcastLog';
import logger from '../utils/logger';

type RateLimitLabel = 'perSecond' | 'perMinute' | 'perHour' | 'perDay';

type FetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

type FetchFunction = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<FetchResponse>;

const resolveFetch = (): FetchFunction => {
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof globalFetch !== 'function') {
    throw new Error('Global fetch API is not available in this runtime');
  }
  return globalFetch.bind(globalThis) as FetchFunction;
};

interface RateLimitWindow {
  label: RateLimitLabel;
  key: string;
  limit: number;
  ttlSeconds: number;
  durationMs: number;
  windowId: number;
}

interface LeadBroadcastJobData {
  id: string;
  logId: string;
  telegramId: string;
  method: LeadBroadcastMethod;
  payload: Record<string, unknown>;
  attempt: number;
  deferredCount: number;
}

interface QuotaResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

const RATE_LIMIT_REASONS: Record<RateLimitLabel, string> = {
  perSecond: 'RATE_LIMIT_PER_SECOND',
  perMinute: 'RATE_LIMIT_PER_MINUTE',
  perHour: 'RATE_LIMIT_PER_HOUR',
  perDay: 'RATE_LIMIT_PER_DAY',
};

export class LeadBroadcastService {
  private static instance: LeadBroadcastService;

  private readonly redisUrl: string;
  private readonly queueName: string;
  private readonly queueKey: string;
  private readonly redisKeyPrefix: string;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly maxDeferrals: number;
  private readonly rateLimitConfig = config.leadBroadcast.limits;
  private readonly localRateCounters = new Map<string, { windowId: number; count: number }>();
  private readonly localQueue: LeadBroadcastJobData[] = [];
  private readonly ready: Promise<void>;
  private readonly fetch: FetchFunction;
  private readonly botToken = config.botToken;
  private readonly botUsername = config.botUsername;
  private readonly apiBaseUrl: string;
  private readonly maxResponseBodyLength = 5_000;

  private redis?: Redis;
  private blockingRedis?: Redis;
  private processingLocal = false;
  private stopping = false;

  private constructor() {
    this.queueName = config.leadBroadcast.queueName;
    const redisUrlFromConfig = config.leadBroadcast.redisUrl || config.redisUrl;
    this.redisUrl = redisUrlFromConfig;
    this.redisKeyPrefix = config.leadBroadcast.redisKeyPrefix || 'lead_broadcast';
    this.queueKey = `${this.redisKeyPrefix}:queue:${this.queueName}`;
    this.retryDelayMs = config.leadBroadcast.retryDelayMs;
    this.maxAttempts = config.leadBroadcast.maxAttempts;
    this.maxDeferrals = config.leadBroadcast.maxDeferrals;
    this.apiBaseUrl = this.botToken ? `https://api.telegram.org/bot${this.botToken}` : '';
    this.fetch = resolveFetch();
    this.ready = this.initialize();
  }

  public static getInstance(): LeadBroadcastService {
    if (!LeadBroadcastService.instance) {
      LeadBroadcastService.instance = new LeadBroadcastService();
    }
    return LeadBroadcastService.instance;
  }

  public async enqueueMessage(
    telegramId: string,
    text: string,
    options?: {
      parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
      disableLinkPreview?: boolean;
      extra?: Record<string, unknown>;
    }
  ): Promise<ILeadBroadcastLog> {
    if (!telegramId) {
      throw new Error('telegramId is required');
    }
    if (!text) {
      throw new Error('text is required');
    }

    await this.ready.catch(() => undefined);

    const payload = this.sanitizePayload({
      chat_id: String(telegramId),
      text,
      parse_mode: options?.parseMode,
      disable_web_page_preview: options?.disableLinkPreview,
      ...options?.extra,
    });

    return this.enqueueJob('sendMessage', telegramId, payload);
  }

  public async enqueueWebhook(
    telegramId: string,
    data: Record<string, unknown>
  ): Promise<ILeadBroadcastLog> {
    if (!telegramId) {
      throw new Error('telegramId is required');
    }

    await this.ready.catch(() => undefined);

    const payload = this.sanitizePayload({
      chat_id: String(telegramId),
      ...data,
    });

    return this.enqueueJob('sendWebhook', telegramId, payload);
  }

  private async enqueueJob(
    method: LeadBroadcastMethod,
    telegramId: string,
    payload: Record<string, unknown>
  ): Promise<ILeadBroadcastLog> {
    const jobId = randomUUID();
    const normalizedId = String(telegramId);

    const logDoc = await LeadBroadcastLog.create({
      jobId,
      telegramId: normalizedId,
      method,
      payload,
      status: 'queued',
      attempts: 0,
      deferredCount: 0,
      queuedAt: new Date(),
      metadata: {
        queueName: this.queueName,
        redisKey: this.queueKey,
        botUsername: this.botUsername,
      },
    });

    const job: LeadBroadcastJobData = {
      id: jobId,
      logId: logDoc.id,
      telegramId: normalizedId,
      method,
      payload,
      attempt: 0,
      deferredCount: 0,
    };

    await this.pushJob(job);

    logger.info('lead_broadcast_enqueued', {
      jobId,
      telegramId: normalizedId,
      method,
    });

    return logDoc;
  }

  private async pushJob(job: LeadBroadcastJobData): Promise<void> {
    if (this.isRedisReady()) {
      try {
        await this.redis!.rpush(this.queueKey, JSON.stringify(job));
        return;
      } catch (error) {
        logger.error('lead_broadcast_enqueue_redis_error', {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.localQueue.push(job);
    this.triggerLocalWorker();
  }

  private triggerLocalWorker(): void {
    if (this.processingLocal) {
      return;
    }
    this.processingLocal = true;
    setImmediate(() => {
      void this.processLocalQueue();
    });
  }

  private async processLocalQueue(): Promise<void> {
    while (this.localQueue.length > 0 && !this.stopping) {
      const job = this.localQueue.shift();
      if (!job) {
        continue;
      }
      await this.handleJob(job);
    }
    this.processingLocal = false;
    if (this.localQueue.length > 0 && !this.processingLocal) {
      this.triggerLocalWorker();
    }
  }

  private async initialize(): Promise<void> {
    if (!this.redisUrl) {
      logger.warn('LeadBroadcastService started without Redis URL, falling back to in-memory queue');
      return;
    }

    const redis = new Redis(this.redisUrl, { lazyConnect: true });
    redis.on('error', (error) => {
      logger.error('lead_broadcast_redis_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    this.redis = redis;

    try {
      await redis.connect();

      this.blockingRedis = redis.duplicate();
      this.blockingRedis.on('error', (error) => {
        logger.error('lead_broadcast_blocking_redis_error', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await this.blockingRedis.connect();

      logger.info('LeadBroadcastService connected to Redis queue', {
        queue: this.queueName,
      });

      void this.consumeRedisQueue();
    } catch (error) {
      logger.error('LeadBroadcastService failed to initialize Redis queue', {
        error: error instanceof Error ? error.message : String(error),
      });

      this.redis?.disconnect();
      this.blockingRedis?.disconnect();
      this.redis = undefined;
      this.blockingRedis = undefined;
    }
  }

  private async consumeRedisQueue(): Promise<void> {
    const client = this.blockingRedis;
    if (!client) {
      return;
    }

    while (!this.stopping) {
      try {
        const result = await client.blpop(this.queueKey, 0);
        if (!result) {
          continue;
        }
        const [, rawJob] = result;
        const job = this.deserializeJob(rawJob);
        if (!job) {
          continue;
        }
        await this.handleJob(job);
      } catch (error) {
        if (this.stopping) {
          break;
        }
        logger.error('lead_broadcast_queue_consume_error', {
          error: error instanceof Error ? error.message : String(error),
        });
        await this.delay(1_000);
      }
    }
  }

  private deserializeJob(raw: string): LeadBroadcastJobData | undefined {
    try {
      const job = JSON.parse(raw) as LeadBroadcastJobData;
      if (!job || !job.id || !job.logId) {
        throw new Error('Invalid job payload');
      }
      return job;
    } catch (error) {
      logger.error('lead_broadcast_deserialize_error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async handleJob(job: LeadBroadcastJobData): Promise<void> {
    const logDoc = await LeadBroadcastLog.findById(job.logId);
    if (!logDoc) {
      logger.warn('lead_broadcast_log_missing', {
        jobId: job.id,
        logId: job.logId,
      });
      return;
    }

    const quota = await this.acquireQuota();
    if (!quota.allowed) {
      await this.handleRateLimit(job, logDoc, quota);
      return;
    }

    if (!this.botToken || !this.apiBaseUrl) {
      await this.failWithoutRetry(job, logDoc, 'BOT_TOKEN is not configured');
      return;
    }

    const currentAttempt = job.attempt + 1;
    job.attempt = currentAttempt;

    logDoc.status = 'processing';
    logDoc.startedAt = new Date();
    logDoc.nextAttemptAt = undefined;
    logDoc.attempts = currentAttempt;
    logDoc.deferredCount = job.deferredCount;
    await logDoc.save();

    const payload = this.ensureChatId(job);

    try {
      const response = await this.fetch(`${this.apiBaseUrl}/${job.method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();
      const responseBody = this.normalizeResponseBody(responseText);
      const telegramOk = typeof responseBody === 'object' && responseBody !== null
        ? Boolean((responseBody as { ok?: boolean }).ok ?? true)
        : response.ok;

      if (!response.ok || !telegramOk) {
        const description = typeof responseBody === 'object' && responseBody !== null
          ? (responseBody as { description?: string }).description
          : undefined;
        const errorMessage = `Telegram API responded with ${response.status}${description ? `: ${description}` : ''}`;
        await this.handleSendFailure(job, logDoc, errorMessage, response.status, responseBody);
        return;
      }

      logDoc.status = 'sent';
      logDoc.finishedAt = new Date();
      logDoc.responseStatus = response.status;
      logDoc.responseBody = responseBody;
      logDoc.lastError = undefined;
      logDoc.deferredCount = job.deferredCount;
      await logDoc.save();

      logger.info('lead_broadcast_sent', {
        jobId: job.id,
        telegramId: job.telegramId,
        method: job.method,
        status: response.status,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.handleSendFailure(job, logDoc, message);
    }
  }

  private async handleSendFailure(
    job: LeadBroadcastJobData,
    logDoc: ILeadBroadcastLog,
    errorMessage: string,
    responseStatus?: number,
    responseBody?: unknown,
  ): Promise<void> {
    if (responseStatus !== undefined) {
      logDoc.responseStatus = responseStatus;
    }
    if (responseBody !== undefined) {
      logDoc.responseBody = responseBody;
    }
    logDoc.lastError = errorMessage;

    if (job.attempt >= this.maxAttempts) {
      logDoc.status = 'failed';
      logDoc.finishedAt = new Date();
      await logDoc.save();

      logger.error('lead_broadcast_failed', {
        jobId: job.id,
        telegramId: job.telegramId,
        method: job.method,
        error: errorMessage,
      });
      return;
    }

    logDoc.status = 'queued';
    logDoc.nextAttemptAt = new Date(Date.now() + this.retryDelayMs);
    await logDoc.save();

    const retryJob: LeadBroadcastJobData = {
      ...job,
    };

    this.scheduleJob(retryJob, this.retryDelayMs);

    logger.warn('lead_broadcast_retry_scheduled', {
      jobId: job.id,
      telegramId: job.telegramId,
      method: job.method,
      attempt: job.attempt,
      retryInMs: this.retryDelayMs,
    });
  }

  private async handleRateLimit(
    job: LeadBroadcastJobData,
    logDoc: ILeadBroadcastLog,
    quota: QuotaResult,
  ): Promise<void> {
    const reason = quota.reason || 'RATE_LIMIT';
    const retryAfterMs = quota.retryAfterMs ?? this.retryDelayMs;

    if (job.deferredCount >= this.maxDeferrals) {
      logDoc.status = 'failed';
      logDoc.lastError = `${reason}: exceeded maximum deferrals`;
      logDoc.finishedAt = new Date();
      await logDoc.save();

      logger.error('lead_broadcast_rate_limit_exceeded', {
        jobId: job.id,
        telegramId: job.telegramId,
        method: job.method,
        reason,
        deferredCount: job.deferredCount,
      });
      return;
    }

    const deferredJob: LeadBroadcastJobData = {
      ...job,
      deferredCount: job.deferredCount + 1,
    };

    logDoc.status = 'queued';
    logDoc.lastError = `Rate limit reached (${reason})`;
    logDoc.nextAttemptAt = new Date(Date.now() + retryAfterMs);
    logDoc.deferredCount = deferredJob.deferredCount;
    await logDoc.save();

    this.scheduleJob(deferredJob, retryAfterMs);

    logger.warn('lead_broadcast_rate_limited', {
      jobId: job.id,
      telegramId: job.telegramId,
      method: job.method,
      reason,
      retryAfterMs,
      deferredCount: deferredJob.deferredCount,
    });
  }

  private async failWithoutRetry(
    job: LeadBroadcastJobData,
    logDoc: ILeadBroadcastLog,
    message: string,
  ): Promise<void> {
    logDoc.status = 'failed';
    logDoc.lastError = message;
    logDoc.finishedAt = new Date();
    await logDoc.save();

    logger.error('lead_broadcast_configuration_error', {
      jobId: job.id,
      telegramId: job.telegramId,
      method: job.method,
      error: message,
    });
  }

  private sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private ensureChatId(job: LeadBroadcastJobData): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...job.payload };
    if (payload.chat_id === undefined) {
      payload.chat_id = job.telegramId;
    }
    return payload;
  }

  private normalizeResponseBody(raw: string): unknown {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      if (trimmed.length > this.maxResponseBodyLength) {
        return `${trimmed.slice(0, this.maxResponseBodyLength)}...`;
      }
      return trimmed;
    }
  }

  private scheduleJob(job: LeadBroadcastJobData, delayMs: number): void {
    const delay = Math.max(0, delayMs);
    const timer = setTimeout(() => {
      this.pushJob(job).catch((error) => {
        logger.error('lead_broadcast_schedule_error', {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  private buildRateLimitWindows(now: number): RateLimitWindow[] {
    const windows: RateLimitWindow[] = [];
    const { perSecond, perMinute, perHour, perDay } = this.rateLimitConfig;

    const appendWindow = (label: RateLimitLabel, limit: number, durationSeconds: number) => {
      if (!limit || limit <= 0) {
        return;
      }
      const durationMs = durationSeconds * 1_000;
      const windowId = Math.floor(now / durationMs);
      const key = `${this.redisKeyPrefix}:rate:${label}:${windowId}`;
      windows.push({
        label,
        key,
        limit,
        ttlSeconds: durationSeconds,
        durationMs,
        windowId,
      });
    };

    appendWindow('perSecond', perSecond, 1);
    appendWindow('perMinute', perMinute, 60);
    appendWindow('perHour', perHour, 3_600);
    appendWindow('perDay', perDay, 86_400);

    return windows;
  }

  private async acquireQuota(): Promise<QuotaResult> {
    const now = Date.now();
    const windows = this.buildRateLimitWindows(now);
    if (windows.length === 0) {
      return { allowed: true };
    }

    if (this.isRedisReady()) {
      try {
        const pipeline = this.redis!.multi();
        for (const window of windows) {
          pipeline.incr(window.key);
          pipeline.expire(window.key, window.ttlSeconds);
        }
        const results = await pipeline.exec();
        if (results) {
          let exceeded: { window: RateLimitWindow; count: number } | undefined;
          const counts: number[] = [];
          for (let i = 0; i < windows.length; i += 1) {
            const result = results[i * 2];
            const valueRaw = result?.[1];
            const value = typeof valueRaw === 'number' ? valueRaw : Number(valueRaw);
            counts[i] = Number.isFinite(value) ? Number(value) : Number.NaN;
            if (Number.isFinite(value) && value > windows[i].limit && !exceeded) {
              exceeded = { window: windows[i], count: value };
            }
          }

          if (exceeded) {
            const rollback = this.redis!.multi();
            for (let i = 0; i < windows.length; i += 1) {
              if (Number.isFinite(counts[i])) {
                rollback.decr(windows[i].key);
              }
            }
            await rollback.exec().catch(() => undefined);

            return {
              allowed: false,
              reason: RATE_LIMIT_REASONS[exceeded.window.label],
              retryAfterMs: this.computeRetryAfter(exceeded.window, now),
            };
          }

          return { allowed: true };
        }
      } catch (error) {
        logger.error('lead_broadcast_quota_redis_error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return this.acquireQuotaLocally(windows, now);
  }

  private acquireQuotaLocally(windows: RateLimitWindow[], now: number): QuotaResult {
    const updates: Array<{ key: string; value: { windowId: number; count: number } }> = [];

    for (const window of windows) {
      const counterKey = `${window.label}`;
      const current = this.localRateCounters.get(counterKey);
      if (!current || current.windowId !== window.windowId) {
        updates.push({ key: counterKey, value: { windowId: window.windowId, count: 1 } });
        continue;
      }

      if (current.count >= window.limit) {
        return {
          allowed: false,
          reason: RATE_LIMIT_REASONS[window.label],
          retryAfterMs: this.computeRetryAfter(window, now),
        };
      }

      updates.push({ key: counterKey, value: { windowId: current.windowId, count: current.count + 1 } });
    }

    for (const update of updates) {
      this.localRateCounters.set(update.key, update.value);
    }

    return { allowed: true };
  }

  private computeRetryAfter(window: RateLimitWindow, now: number): number {
    const nextWindowStart = (window.windowId + 1) * window.durationMs;
    const wait = nextWindowStart - now;
    return wait > 0 ? wait : this.retryDelayMs;
  }

  private isRedisReady(): boolean {
    return Boolean(this.redis && this.redis.status === 'ready');
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
  }
}

export const leadBroadcastService = LeadBroadcastService.getInstance();

export default LeadBroadcastService;

