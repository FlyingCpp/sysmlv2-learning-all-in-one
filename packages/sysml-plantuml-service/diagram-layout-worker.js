'use strict';

const { parentPort } = require('worker_threads');
const ELK = require('elkjs/lib/elk.bundled.js');

parentPort.once('message', async ({ graph, document, portMap, deadline }) => {
  try {
    const laidOut = await new ELK().layout(graph);
    const result = require('./diagram-layout').finishLayout(document, laidOut, portMap, deadline);
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: String(error.message || error), code: error.code });
  }
});
