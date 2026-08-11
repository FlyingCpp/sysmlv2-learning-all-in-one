'use strict';

class ValidatorAdmissionError extends Error {
  constructor(code, message, status, details = {}) {
    super(message);
    this.name = 'ValidatorAdmissionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

class ValidatorAdmissionQueue {
  constructor(options = {}) {
    this.maxInFlight = strictInteger(options.maxInFlight, 1, 1, 1, 'maxInFlight');
    this.queueLimit = strictInteger(options.queueLimit, 8, 0, 1000, 'queueLimit');
    this.queueWaitMs = strictInteger(options.queueWaitMs, 15000, 1, 300000, 'queueWaitMs');
    this.inFlight = 0;
    this.queue = [];
    this.sequence = 0;
    this.metrics = {
      admitted: 0,
      completed: 0,
      failed: 0,
      queueFull: 0,
      queueTimeout: 0,
      abortedBeforeStart: 0,
      abortedAfterStart: 0,
      totalQueueWaitMs: 0,
      totalExecutionMs: 0
    };
  }

  run(operation, options = {}) {
    if (typeof operation !== 'function') throw new TypeError('Validator operation must be a function.');
    const signal = options.signal;
    if (signal?.aborted) {
      this.metrics.abortedBeforeStart += 1;
      const error = admissionError('VALIDATOR_ABORTED_BEFORE_START');
      error.validatorObservation = observation('aborted_before_start', 0, 0, false, false);
      options.onObservation?.(error.validatorObservation);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const item = {
        id: ++this.sequence,
        enqueuedAtMs: Date.now(),
        operation,
        signal,
        resolve,
        reject,
        started: false,
        timer: null,
        onAbort: null,
        onObservation: options.onObservation,
        observationRecorded: false,
        queueWaitMs: 0
      };
      item.onAbort = () => {
        if (item.started) return;
        const index = this.queue.indexOf(item);
        if (index >= 0) this.queue.splice(index, 1);
        this.clearWaitingItem(item);
        this.metrics.abortedBeforeStart += 1;
        reject(this.rejectWithObservation(item, 'VALIDATOR_ABORTED_BEFORE_START', 'aborted_before_start'));
      };
      signal?.addEventListener('abort', item.onAbort, { once: true });

      if (this.inFlight < this.maxInFlight) {
        this.start(item);
        return;
      }
      if (this.queue.length >= this.queueLimit) {
        this.clearWaitingItem(item);
        this.metrics.queueFull += 1;
        reject(this.rejectWithObservation(
          item,
          'VALIDATOR_QUEUE_FULL',
          'queue_full',
          { queueDepth: this.queue.length },
        ));
        return;
      }
      item.timer = setTimeout(() => {
        const index = this.queue.indexOf(item);
        if (index < 0 || item.started) return;
        this.queue.splice(index, 1);
        this.clearWaitingItem(item);
        this.metrics.queueTimeout += 1;
        const waitedMs = Date.now() - item.enqueuedAtMs;
        item.queueWaitMs = waitedMs;
        reject(this.rejectWithObservation(
          item,
          'VALIDATOR_QUEUE_TIMEOUT',
          'queue_timeout',
          { waitedMs },
        ));
      }, this.queueWaitMs);
      this.queue.push(item);
    });
  }

  snapshot() {
    const completed = this.metrics.completed + this.metrics.failed;
    return Object.freeze({
      maxInFlight: this.maxInFlight,
      queueLimit: this.queueLimit,
      queueWaitMs: this.queueWaitMs,
      inFlight: this.inFlight,
      queueDepth: this.queue.length,
      admitted: this.metrics.admitted,
      completed: this.metrics.completed,
      failed: this.metrics.failed,
      queueFull: this.metrics.queueFull,
      queueTimeout: this.metrics.queueTimeout,
      abortedBeforeStart: this.metrics.abortedBeforeStart,
      abortedAfterStart: this.metrics.abortedAfterStart,
      averageQueueWaitMs: this.metrics.admitted > 0
        ? Math.round(this.metrics.totalQueueWaitMs / this.metrics.admitted)
        : 0,
      averageExecutionMs: completed > 0
        ? Math.round(this.metrics.totalExecutionMs / completed)
        : 0
    });
  }

  start(item) {
    item.started = true;
    this.clearWaitingItem(item);
    this.inFlight += 1;
    this.metrics.admitted += 1;
    item.queueWaitMs = Date.now() - item.enqueuedAtMs;
    this.metrics.totalQueueWaitMs += item.queueWaitMs;
    const startedAtMs = Date.now();
    Promise.resolve().then(item.operation).then(
      (value) => {
        const executionMs = Date.now() - startedAtMs;
        this.metrics.completed += 1;
        if (item.signal?.aborted) {
          this.metrics.abortedAfterStart += 1;
          item.reject(this.rejectWithObservation(
            item,
            'VALIDATOR_ABORTED_AFTER_START',
            'aborted_after_start',
            {},
            executionMs,
          ));
        } else {
          this.recordObservation(item, observation('admitted', item.queueWaitMs, executionMs, false, false));
          item.resolve(value);
        }
      },
      (error) => {
        const executionMs = Date.now() - startedAtMs;
        this.metrics.failed += 1;
        if (item.signal?.aborted) {
          this.metrics.abortedAfterStart += 1;
          item.reject(this.rejectWithObservation(
            item,
            'VALIDATOR_ABORTED_AFTER_START',
            'aborted_after_start',
            {},
            executionMs,
          ));
          return;
        }
        const outcome = String(error?.code || '').includes('TIMEOUT')
          ? 'execution_timeout'
          : 'backend_unavailable';
        const validatorObservation = observation(outcome, item.queueWaitMs, executionMs, false, false);
        this.recordObservation(item, validatorObservation);
        if (error && typeof error === 'object') error.validatorObservation = validatorObservation;
        item.reject(error);
      }
    ).finally(() => {
      this.metrics.totalExecutionMs += Date.now() - startedAtMs;
      this.inFlight -= 1;
      this.drain();
    });
  }

  drain() {
    while (this.inFlight < this.maxInFlight && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item || item.signal?.aborted) {
        if (item) {
          this.clearWaitingItem(item);
          this.metrics.abortedBeforeStart += 1;
          item.reject(this.rejectWithObservation(item, 'VALIDATOR_ABORTED_BEFORE_START', 'aborted_before_start'));
        }
        continue;
      }
      this.start(item);
    }
  }

  clearWaitingItem(item) {
    if (item.timer) clearTimeout(item.timer);
    item.timer = null;
    if (item.onAbort) item.signal?.removeEventListener('abort', item.onAbort);
  }

  recordObservation(item, validatorObservation) {
    if (item.observationRecorded) return;
    item.observationRecorded = true;
    item.onObservation?.(validatorObservation);
  }

  rejectWithObservation(item, code, outcome, details = {}, executionMs = 0) {
    const error = admissionError(code, details);
    const validatorObservation = observation(
      outcome,
      item.queueWaitMs || Math.max(0, Date.now() - item.enqueuedAtMs),
      executionMs,
      ['queue_full', 'queue_timeout'].includes(outcome),
      outcome === 'aborted_after_start',
    );
    if (outcome === 'queue_full') validatorObservation.queueWaitMs = 0;
    error.validatorObservation = validatorObservation;
    this.recordObservation(item, validatorObservation);
    return error;
  }
}

function observation(admissionOutcome, queueWaitMs, executionMs, retryableBeforeStart, abortedAfterStart) {
  return {
    attempt: 1,
    admissionOutcome,
    queueWaitMs: Math.max(0, Math.round(queueWaitMs || 0)),
    executionMs: Math.max(0, Math.round(executionMs || 0)),
    retryableBeforeStart: retryableBeforeStart === true,
    abortedAfterStart: abortedAfterStart === true
  };
}

function admissionError(code, details = {}) {
  const definitions = {
    VALIDATOR_QUEUE_FULL: ['Validator admission queue is full.', 429],
    VALIDATOR_QUEUE_TIMEOUT: ['Validator request timed out before execution started.', 503],
    VALIDATOR_ABORTED_BEFORE_START: ['Validator request was cancelled before execution started.', 499],
    VALIDATOR_ABORTED_AFTER_START: ['Validator request was cancelled after execution started.', 499]
  };
  const [message, status] = definitions[code] || ['Validator admission failed.', 503];
  return new ValidatorAdmissionError(code, message, status, details);
}

function strictInteger(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

module.exports = {
  ValidatorAdmissionError,
  ValidatorAdmissionQueue,
  admissionError
};
