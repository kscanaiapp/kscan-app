#!/usr/bin/env node
'use strict';
const { duplicateAnalysis } = require('./calibration-report');
console.log(JSON.stringify(duplicateAnalysis(), null, 2));
