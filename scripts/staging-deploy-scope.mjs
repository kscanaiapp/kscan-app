import { pathToFileURL } from 'node:url';

/** One function OR one approved migration, never an implicit deployment. */
export function resolveStagingDeployScope({ functionName, verifyJwt, approvedVersion = '', approveMigration = 'NO' }) {
  if (typeof functionName !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(functionName) || functionName === 'all') {
    throw new Error('Exactly one function or none is required');
  }
  if (!['true', 'false'].includes(verifyJwt)) throw new Error('verify_jwt must be true or false');
  if (approvedVersion && !/^\d{12,14}$/.test(approvedVersion)) throw new Error('Invalid approved migration version');
  const migrationOnly = functionName === 'none';
  if (migrationOnly && (!approvedVersion || approveMigration !== 'YES')) {
    throw new Error('Migration-only requires one exact approved version and approve_migration=YES');
  }
  return { function_name: functionName, verify_jwt: verifyJwt,
    migration_version: approvedVersion, migration_only: String(migrationOnly),
    deploy_functions: migrationOnly ? '' : functionName };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scope = resolveStagingDeployScope({ functionName: process.env.FUNCTION_NAME,
    verifyJwt: process.env.VERIFY_JWT, approvedVersion: process.env.APPROVED_MIGRATION_VERSION,
    approveMigration: process.env.APPROVE_MIGRATION });
  for (const [key, value] of Object.entries(scope)) console.log(`${key}=${value}`);
}
