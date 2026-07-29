#!/usr/bin/env node
'use strict';
const { commerceLinkCheck } = require('./calibration-report');
console.log(JSON.stringify(commerceLinkCheck(), null, 2));
