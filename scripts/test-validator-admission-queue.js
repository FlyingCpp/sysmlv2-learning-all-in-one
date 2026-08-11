'use strict';

const assert = require('assert');
const { ValidatorAdmissionQueue } = require('../apps/validator/admission-queue');
const { OfficialValidatorBackend } = require('../apps/validator/official-backend');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

async function testBoundedFifoAndQueueFull() {
  const queue = new ValidatorAdmissionQueue({ maxInFlight: 1, queueLimit: 1, queueWaitMs: 1000 });
  const first = deferred();
  const order = [];
  const firstRun = queue.run(async () => {
    order.push('first');
    return first.promise;
  });
  const secondRun = queue.run(async () => {
    order.push('second');
    return 'second-result';
  });
  let fullObservation;
  await expectCode(queue.run(async () => 'must-not-run', {
    onObservation: (value) => { fullObservation = value; }
  }), 'VALIDATOR_QUEUE_FULL');
  assert.strictEqual(fullObservation.admissionOutcome, 'queue_full');
  assert.strictEqual(fullObservation.queueWaitMs, 0);
  assert.strictEqual(fullObservation.executionMs, 0);
  assert.strictEqual(fullObservation.retryableBeforeStart, true);
  assert.deepStrictEqual(order, ['first']);
  first.resolve('first-result');
  assert.strictEqual(await firstRun, 'first-result');
  assert.strictEqual(await secondRun, 'second-result');
  assert.deepStrictEqual(order, ['first', 'second']);
  assert.strictEqual(queue.snapshot().queueFull, 1);
}

async function testQueuedCancellationAndTimeoutNeverExecute() {
  const queue = new ValidatorAdmissionQueue({ maxInFlight: 1, queueLimit: 2, queueWaitMs: 15 });
  const first = deferred();
  let queuedExecutions = 0;
  const firstRun = queue.run(() => first.promise);
  const queuedAbort = new AbortController();
  const cancelled = queue.run(async () => {
    queuedExecutions += 1;
  }, { signal: queuedAbort.signal });
  queuedAbort.abort();
  await expectCode(cancelled, 'VALIDATOR_ABORTED_BEFORE_START');
  let timeoutObservation;
  await expectCode(queue.run(async () => {
    queuedExecutions += 1;
  }, { onObservation: (value) => { timeoutObservation = value; } }), 'VALIDATOR_QUEUE_TIMEOUT');
  assert.strictEqual(timeoutObservation.admissionOutcome, 'queue_timeout');
  assert.strictEqual(timeoutObservation.executionMs, 0);
  assert.strictEqual(queuedExecutions, 0);
  first.resolve('done');
  await firstRun;
}

async function testActiveCancellationDoesNotReleaseCapacityEarly() {
  const queue = new ValidatorAdmissionQueue({ maxInFlight: 1, queueLimit: 1, queueWaitMs: 1000 });
  const first = deferred();
  const activeAbort = new AbortController();
  let secondStarted = false;
  let activeObservation;
  const active = queue.run(() => first.promise, {
    signal: activeAbort.signal,
    onObservation: (value) => { activeObservation = value; }
  });
  const activeSettlement = active.catch((error) => error);
  const second = queue.run(async () => {
    secondStarted = true;
    return 'second';
  });
  activeAbort.abort();
  await Promise.resolve();
  assert.strictEqual(secondStarted, false, 'cancelled active validation must retain capacity until its backend operation settles');
  first.resolve('ignored');
  const activeError = await activeSettlement;
  assert.strictEqual(activeError.code, 'VALIDATOR_ABORTED_AFTER_START');
  assert.strictEqual(activeObservation.admissionOutcome, 'aborted_after_start');
  assert.strictEqual(activeObservation.abortedAfterStart, true);
  assert.strictEqual(await second, 'second');
  assert.strictEqual(queue.snapshot().abortedAfterStart, 1);
}

async function main() {
  assert.throws(
    () => new ValidatorAdmissionQueue({ maxInFlight: 2 }),
    /maxInFlight must be an integer between 1 and 1/,
    'the current single Java process must reject unsafe concurrency configuration'
  );
  assert.throws(
    () => new OfficialValidatorBackend({ timeoutMs: 0 }),
    /AI_TEACHER_VALIDATOR_EXECUTION_TIMEOUT_MS must be an integer between 1 and 300000/,
    'invalid Validator execution timeout must fail at startup rather than becoming a zero/NaN timer'
  );
  await testBoundedFifoAndQueueFull();
  await testQueuedCancellationAndTimeoutNeverExecute();
  await testActiveCancellationDoesNotReleaseCapacityEarly();
  console.log('validator admission queue tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
