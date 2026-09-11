'use strict';

const OFFICIAL_SOURCE = 'official-sysml-v2-pilot-2026-04';
const RELEASE_TAG = process.env.SYSML_RELEASE_TAG || '2026-04';
const KERNEL_VERSION = process.env.SYSML_KERNEL_VERSION || '0.59.0';

module.exports = { OFFICIAL_SOURCE, RELEASE_TAG, KERNEL_VERSION };
