'use strict';

const { Agent } = require('undici');

const BUSINESS_DEADLINE_TRANSPORT_OPTIONS = Object.freeze({
  connectTimeout: 0,
  headersTimeout: 0,
  bodyTimeout: 0
});

const businessDeadlineDispatcher = new Agent(BUSINESS_DEADLINE_TRANSPORT_OPTIONS);

/**
 * API到Teacher的内部传输不拥有独立计时器。调用方现有的Run/API
 * AbortSignal是唯一主动截止，底层网络错误继续按异常处理。
 */
function businessDeadlineFetch(input, init) {
  return fetch(input, {
    ...init,
    dispatcher: businessDeadlineDispatcher
  });
}

module.exports = {
  businessDeadlineFetch,
  businessDeadlineTransportOptions: BUSINESS_DEADLINE_TRANSPORT_OPTIONS
};
