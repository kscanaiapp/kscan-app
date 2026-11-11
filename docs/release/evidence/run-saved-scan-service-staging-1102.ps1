$ErrorActionPreference='Stop'
$keys=supabase projects api-keys --project-ref yzqjvdfgefveprobvvyw --output json|ConvertFrom-Json
try{
 $env:B35_AUDIT_STAGING_SERVICE_ROLE=($keys|Where-Object {$_.name -eq 'service_role'}).api_key
 $env:B35_AUDIT_STAGING_ANON=($keys|Where-Object {$_.name -eq 'anon'}).api_key
 node C:/b35readback1030/saved-scan-service-staging-1102.cjs
}finally{Remove-Item Env:B35_AUDIT_STAGING_SERVICE_ROLE,Env:B35_AUDIT_STAGING_ANON -ErrorAction SilentlyContinue;Remove-Variable keys -ErrorAction SilentlyContinue}
