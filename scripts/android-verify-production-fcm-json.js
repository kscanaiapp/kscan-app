#!/usr/bin/env node
'use strict';

// Android-only EAS Production Firebase JSON preflight. Prints no secret values.
// Run on an EAS Workflows VM with environment: production.
const fs = require('node:fs');
const path = require('node:path');

const expectedProjectId = 'k-scan-ai-47404';
const expectedPackage = 'com.kscanai.app';
const fail = message => { console.error('FCM JSON PREFLIGHT: FAIL — ' + message); process.exitCode = 1; };

function verify() {
  const candidate = process.env.GOOGLE_SERVICES_JSON;
  if (!candidate) return fail('Production GOOGLE_SERVICES_JSON is not injected');
  if (!path.isAbsolute(candidate)) return fail('GOOGLE_SERVICES_JSON must be an absolute file path, not inline JSON');
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile())
    return fail('GOOGLE_SERVICES_JSON does not point to a readable file');

  let json;
  try { json = JSON.parse(fs.readFileSync(candidate, 'utf8')); }
  catch { return fail('Firebase configuration is not valid JSON'); }

  if (json?.project_info?.project_id !== expectedProjectId)
    return fail('Firebase project_id does not match the assigned FCM V1 credential project');
  if (!/^\d+$/.test(String(json?.project_info?.project_number || '')))
    return fail('Firebase project_number is missing or invalid');
  if (!/^https?:\/\//.test(String(json?.project_info?.firebase_url || '')) &&
      json?.project_info?.firebase_url !== undefined)
    return fail('Firebase database URL, if present, must be HTTP(S)');

  const clients = (Array.isArray(json?.client) ? json.client : [])
    .filter(client => client?.client_info?.android_client_info?.package_name === expectedPackage);
  if (!clients.length) return fail('No Firebase Android client matches com.kscanai.app');
  if (!clients.some(client => /^[^\s:]+:[^\s:]+:android:[^\s:]+$/.test(String(client?.client_info?.mobilesdk_app_id || ''))))
    return fail('Matching Android client has no valid mobilesdk_app_id');
  if (!clients.some(client => Array.isArray(client.api_key) &&
      client.api_key.some(key => typeof key?.current_key === 'string' && key.current_key.trim().length > 0)))
    return fail('Matching Android client has no Firebase API key');

  console.log('FCM JSON PREFLIGHT: PASS (Production secret file, valid JSON, Firebase project, Android package, app ID and API-key presence)');
  console.log('FCM JSON PREFLIGHT: No credential content printed; delivery and AAB integration still require post-build verification.');
}
verify();
