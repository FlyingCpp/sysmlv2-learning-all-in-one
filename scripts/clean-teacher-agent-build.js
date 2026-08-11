'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const buildDirectory = path.join(root, 'apps', 'teacher', 'dist', 'agent');
fs.rmSync(buildDirectory, { recursive: true, force: true });
