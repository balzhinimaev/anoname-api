import { wsLogger } from './logger';

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeout: number;
  halfOpenMaxAttempts: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;
  
  constructor(
    private readonly options: CircuitBreakerOptions = {
      failureThreshold: 5,
      resetTimeout: 60000, // 1 minute
      halfOpenMaxAttempts: 3
    }
  ) {}

  public async execute<T>(
    operation: () => Promise<T>,
    fallback?: () => Promise<T>
  ): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (this.shouldAttemptReset()) {
        this.transitionToHalfOpen();
      } else {
        wsLogger.warn('circuit_breaker', 'Circuit is OPEN', {
          lastFailure: new Date(this.lastFailureTime).toISOString(),
          failures: this.failures
        });
        return this.handleOpenCircuit(fallback);
      }
    }

    try {
      const result = await operation();
      this.handleSuccess();
      return result;
    } catch (error) {
      return this.handleFailure(error, fallback);
    }
  }

  private shouldAttemptReset(): boolean {
    return Date.now() - this.lastFailureTime >= this.options.resetTimeout;
  }

  private transitionToHalfOpen(): void {
    this.state = CircuitState.HALF_OPEN;
    this.halfOpenAttempts = 0;
    wsLogger.info('circuit_breaker', 'Circuit transitioned to HALF_OPEN');
  }

  private async handleOpenCircuit<T>(
    fallback?: () => Promise<T>
  ): Promise<T> {
    if (fallback) {
      return await fallback();
    }
    throw new Error('Circuit is OPEN');
  }

  private handleSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenAttempts++;
      if (this.halfOpenAttempts >= this.options.halfOpenMaxAttempts) {
        this.state = CircuitState.CLOSED;
        this.failures = 0;
        wsLogger.info('circuit_breaker', 'Circuit CLOSED after successful recovery');
      }
    }
  }

  private async handleFailure<T>(
    error: any,
    fallback?: () => Promise<T>
  ): Promise<T> {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (
      this.state === CircuitState.CLOSED &&
      this.failures >= this.options.failureThreshold
    ) {
      this.state = CircuitState.OPEN;
      wsLogger.warn('circuit_breaker', 'Circuit OPENED', {
        failures: this.failures,
        lastFailure: new Date(this.lastFailureTime).toISOString()
      });
    }

    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
      wsLogger.warn('circuit_breaker', 'Circuit returned to OPEN state from HALF_OPEN');
    }

    if (fallback) {
      return await fallback();
    }
    throw error;
  }

  public getState(): CircuitState {
    return this.state;
  }

  public getFailures(): number {
    return this.failures;
  }
} 