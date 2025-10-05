import { EventEmitter } from 'events';

type MetricsState = {
  connections: {
    current: number;
    total: number;
    peak: number;
  };
  messages: {
    total: number;
    perMinute: number;
  };
  searches: {
    active: number;
    total: number;
    successful: number;
  };
  latency: {
    avg: number;
    samples: number[];
  };
  errors: {
    count: number;
    lastError?: Error;
  };
  ws: {
    validationFailed: number;
    rateLimited: number;
    validationFailedByEvent: Record<string, number>;
    rateLimitedByEvent: Record<string, number>;
  };
  reports: {
    submittedTotal: number;
    errorsTotal: number;
    rateLimitedTotal: number;
    byReason: Record<string, number>;
  };
  leads: {
    add: {
      attempts: number;
      created: number;
      duplicates: number;
      failed: number;
    };
    notifications: {
      sent: number;
      failed: number;
    };
    tmaOpens: {
      total: number;
      newLead: number;
      failed: number;
    };
    registrations: {
      attempts: number;
      success: number;
      failed: number;
    };
    conversions: {
      toTmaOpen: number;
      toRegistration: number;
    };
    campaigns: {
      launched: number;
      dryRuns: number;
      messageAttempts: number;
      queued: number;
      failed: number;
    };
  };
  prelaunch: {
    joins: {
      attempted: number;
      succeeded: number;
      failed: number;
    };
    broadcasts: {
      attempted: number;
      succeeded: number;
      failed: number;
    };
  };
  referrals: {
    codesGenerated: number;
    collisions: number;
    attributed: number;
    qualified: number;
    rewarded: number;
    errors: number;
  };
};

class MetricsCollector extends EventEmitter {
  private metrics: MetricsState;

  private messageCountStartTime: number;
  private readonly SAMPLE_WINDOW = 60000; // 1 минута

  constructor() {
    super();
    this.metrics = this.createInitialState();
    this.messageCountStartTime = Date.now();
    this.startPeriodicUpdates();
  }

  private createInitialState(): MetricsState {
    return {
      connections: { current: 0, total: 0, peak: 0 },
      messages: { total: 0, perMinute: 0 },
      searches: { active: 0, total: 0, successful: 0 },
      latency: { avg: 0, samples: [] },
      errors: { count: 0 },
      ws: {
        validationFailed: 0,
        rateLimited: 0,
        validationFailedByEvent: {},
        rateLimitedByEvent: {},
      },
      reports: {
        submittedTotal: 0,
        errorsTotal: 0,
        rateLimitedTotal: 0,
        byReason: {}
      },
      leads: {
        add: { attempts: 0, created: 0, duplicates: 0, failed: 0 },
        notifications: { sent: 0, failed: 0 },
        tmaOpens: { total: 0, newLead: 0, failed: 0 },
        registrations: { attempts: 0, success: 0, failed: 0 },
        conversions: { toTmaOpen: 0, toRegistration: 0 },
        campaigns: { launched: 0, dryRuns: 0, messageAttempts: 0, queued: 0, failed: 0 },
      },
      prelaunch: {
        joins: { attempted: 0, succeeded: 0, failed: 0 },
        broadcasts: { attempted: 0, succeeded: 0, failed: 0 },
      },
      referrals: {
        codesGenerated: 0,
        collisions: 0,
        attributed: 0,
        qualified: 0,
        rewarded: 0,
        errors: 0,
      },
    };
  }

  private startPeriodicUpdates() {
    setInterval(() => {
      this.updateMessageRate();
      this.emit('metrics_updated', this.getMetrics());
    }, 5000); // Обновление каждые 5 секунд
  }

  private updateMessageRate() {
    const now = Date.now();
    const timeWindow = now - this.messageCountStartTime;
    this.metrics.messages.perMinute = 
      (this.metrics.messages.total / timeWindow) * this.SAMPLE_WINDOW;
  }

  // Методы для обновления метрик
  connectionOpened() {
    this.metrics.connections.current++;
    this.metrics.connections.total++;
    this.metrics.connections.peak = Math.max(
      this.metrics.connections.peak,
      this.metrics.connections.current
    );
  }

  connectionClosed() {
    this.metrics.connections.current--;
  }

  messageProcessed(latency: number) {
    this.metrics.messages.total++;
    this.metrics.latency.samples.push(latency);
    
    // Обновляем среднюю задержку
    if (this.metrics.latency.samples.length > 100) {
      this.metrics.latency.samples.shift();
    }
    this.metrics.latency.avg = this.metrics.latency.samples.reduce(
      (a, b) => a + b, 0
    ) / this.metrics.latency.samples.length;
  }

  // WS failure counters
  wsValidationFailed(eventName: string) {
    this.metrics.ws.validationFailed++;
    if (!this.metrics.ws.validationFailedByEvent[eventName]) {
      this.metrics.ws.validationFailedByEvent[eventName] = 0;
    }
    this.metrics.ws.validationFailedByEvent[eventName]++;
  }

  wsRateLimited(eventName: string) {
    this.metrics.ws.rateLimited++;
    if (!this.metrics.ws.rateLimitedByEvent[eventName]) {
      this.metrics.ws.rateLimitedByEvent[eventName] = 0;
    }
    this.metrics.ws.rateLimitedByEvent[eventName]++;
    if (eventName === 'chat:report') {
      this.metrics.reports.rateLimitedTotal++;
    }
  }

  searchStarted() {
    this.metrics.searches.active++;
    this.metrics.searches.total++;
  }

  searchCompleted(successful: boolean) {
    this.metrics.searches.active--;
    if (successful) {
      this.metrics.searches.successful++;
    }
  }

  errorOccurred(error: Error) {
    this.metrics.errors.count++;
    this.metrics.errors.lastError = error;
  }

  leadAddCreated() {
    this.metrics.leads.add.attempts++;
    this.metrics.leads.add.created++;
  }

  leadAddDuplicate() {
    this.metrics.leads.add.attempts++;
    this.metrics.leads.add.duplicates++;
  }

  leadAddFailed() {
    this.metrics.leads.add.attempts++;
    this.metrics.leads.add.failed++;
  }

  leadNotificationSent() {
    this.metrics.leads.notifications.sent++;
  }

  leadNotificationFailed() {
    this.metrics.leads.notifications.failed++;
  }

  leadTmaOpened(createdNewLead: boolean) {
    this.metrics.leads.tmaOpens.total++;
    if (createdNewLead) {
      this.metrics.leads.tmaOpens.newLead++;
    }
    this.metrics.leads.conversions.toTmaOpen++;
  }

  leadTmaOpenFailed() {
    this.metrics.leads.tmaOpens.failed++;
  }

  leadRegistered(success: boolean) {
    this.metrics.leads.registrations.attempts++;
    if (success) {
      this.metrics.leads.registrations.success++;
      this.metrics.leads.conversions.toRegistration++;
    } else {
      this.metrics.leads.registrations.failed++;
    }
  }

  leadCampaignLaunchStarted(isDryRun: boolean) {
    this.metrics.leads.campaigns.launched++;
    if (isDryRun) {
      this.metrics.leads.campaigns.dryRuns++;
    }
  }

  leadCampaignMessageQueued(success: boolean) {
    this.metrics.leads.campaigns.messageAttempts++;
    if (success) {
      this.metrics.leads.campaigns.queued++;
    } else {
      this.metrics.leads.campaigns.failed++;
    }
  }

  prelaunchJoin(success: boolean) {
    this.metrics.prelaunch.joins.attempted++;
    if (success) {
      this.metrics.prelaunch.joins.succeeded++;
    } else {
      this.metrics.prelaunch.joins.failed++;
    }
  }

  prelaunchBroadcast(success: boolean) {
    this.metrics.prelaunch.broadcasts.attempted++;
    if (success) {
      this.metrics.prelaunch.broadcasts.succeeded++;
    } else {
      this.metrics.prelaunch.broadcasts.failed++;
    }
  }

  referralCodeEnsured(collision: boolean) {
    this.metrics.referrals.codesGenerated++;
    if (collision) {
      this.metrics.referrals.collisions++;
    }
  }

  referralAttributed() {
    this.metrics.referrals.attributed++;
  }

  referralQualified() {
    this.metrics.referrals.qualified++;
  }

  referralRewarded() {
    this.metrics.referrals.rewarded++;
  }

  referralErrored() {
    this.metrics.referrals.errors++;
  }

  // Получение текущих метрик
  getMetrics() {
    return {
      ...this.metrics,
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    };
  }

  // Reports metrics
  reportSubmitted(reason: string) {
    this.metrics.reports.submittedTotal++;
    if (!this.metrics.reports.byReason[reason]) {
      this.metrics.reports.byReason[reason] = 0;
    }
    this.metrics.reports.byReason[reason]++;
  }

  reportErrored(reason: string) {
    this.metrics.reports.errorsTotal++;
    if (reason) {
      if (!this.metrics.reports.byReason[reason]) {
        this.metrics.reports.byReason[reason] = 0;
      }
    }
  }

  // Сброс метрик
  reset() {
    this.metrics = this.createInitialState();
    this.messageCountStartTime = Date.now();
  }
}

export const metricsCollector = new MetricsCollector();
