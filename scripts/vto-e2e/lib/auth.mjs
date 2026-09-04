/**
 * Runtime authentication for VTO E2E actors — thin re-export of the
 * existing governed pattern in security/scripts/synthetic-auth.js
 * (password-grant sign-in via the publishable key, immediate masking).
 * Not reimplemented: importing the CommonJS module directly keeps this
 * harness and the synthetic-staging-tests suite from ever disagreeing about
 * what "signed in" or "masked" mean.
 */
'use strict';

import syntheticAuth from '../../../security/scripts/synthetic-auth.js';

export const { signInSyntheticUser, maskLine, assertNotProductionUrl } = syntheticAuth;
