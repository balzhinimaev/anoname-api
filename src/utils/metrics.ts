import { EventEmitter } from 'events';

class MetricsCollector extends EventEmitter {
  private metrics: {
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
  };

  private messageCountStartTime: number;
  private readonly SAMPLE_WINDOW = 60000; // 1 минута

  constructor() {
    super();
    this.metrics = {
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
      }
    };
    this.messageCountStartTime = Date.now();
    this.startPeriodicUpdates();
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
    this.metrics = {
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
      }
    };
    this.messageCountStartTime = Date.now();
  }
}

export const metricsCollector = new MetricsCollector(); 