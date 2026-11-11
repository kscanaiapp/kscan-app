$ErrorActionPreference='Stop'
$ref='yzqjvdfgefveprobvvyw';$base='https://yzqjvdfgefveprobvvyw.supabase.co';$statePath='C:/b35readback1030/staging-expiry-fixture.dpapi'
Add-Type -AssemblyName System.Security
$plain=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($statePath),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
$fixture=[Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json;[Array]::Clear($plain,0,$plain.Length)
if($fixture.projectRef -ne $ref -or $fixture.runId -ne '0d008232cb0c474ba3ec0dc7b20d398c'){throw 'Fixture project/tag mismatch'}
if([DateTime]::UtcNow -le [DateTime]::Parse($fixture.expiresAtUtc).ToUniversalTime()){throw 'JWT has not naturally expired'}
$keys=supabase projects api-keys --project-ref $ref --output json|ConvertFrom-Json
$admin=($keys|Where-Object {$_.name -eq 'service_role'}).api_key;$anon=($keys|Where-Object {$_.name -eq 'anon'}).api_key
if(!$admin -or !$anon){throw 'Staging authority unavailable'}
$records=@();$errors=@();$cleanupConfirmed=$false
function Api($method,$path,$token,$body=$null){
 $h=@{apikey=$anon;Authorization=('Bearer '+$token)};if($token -eq $admin){$h.apikey=$admin}
 $args=@{Method=$method;Uri=($base+$path);Headers=$h;ContentType='application/json';UseBasicParsing=$true;TimeoutSec=20};if($null -ne $body){$args.Body=$body}
 try{$r=Invoke-WebRequest @args;return @{status=[int]$r.StatusCode;content=$r.Content}}catch{if($_.Exception.Response){return @{status=[int]$_.Exception.Response.StatusCode;content=([IO.StreamReader]::new($_.Exception.Response.GetResponseStream())).ReadToEnd()}};throw}
}
function Record($boundary,$expected,$actual,$ok){$script:records+=@{probeId=('B35-EXPIRED-JWT-'+($script:records.Count+1).ToString('000'));boundary=$boundary;probe='naturally expired, previously valid synthetic JWT';expected=$expected;actual=$actual;verdict=$(if($ok){'PASS'}else{'FAIL'});environment='Real Staging HTTPS';runId=$fixture.runId}}
try{
 $r=Api Get '/auth/v1/user' $fixture.accessToken
 Record 'Supabase Auth /auth/v1/user' '401 for naturally expired signed user token' @{http=$r.status;explicitExpiry=($r.content -match 'expir')} ($r.status -eq 401)
 if($r.status -ne 401){throw 'Expired-token Auth control did not reject; no further requests'}
 $targets=Get-Content -Raw -LiteralPath C:/b35readback1030/staging-expired-jwt-targets-1102.json|ConvertFrom-Json
 foreach($target in $targets){
  if($target.verify_jwt -ne $true -or $target.slug -notmatch '^[a-z0-9-]+$'){throw 'Unvalidated function target'}
  $r=Api Post ('/functions/v1/'+$target.slug) $fixture.accessToken '{}'
  Record ('function:'+$target.slug) '401 JWT gateway denial before handler/provider execution' @{http=$r.status;deploymentVersion=$target.version;verifyJwt=$true;response=$r.content} ($r.status -eq 401)
 }
 $r=Api Get ('/rest/v1/profiles?select=id&id=eq.'+$fixture.actorId) $fixture.accessToken
 Record 'PostgREST own synthetic profile' '401 expired token before row access' @{http=$r.status} ($r.status -eq 401)
}catch{$errors+=@{disposition='HARNESS/NETWORK ERROR';message=$_.Exception.Message}}
finally{
 $r=Api Get ('/auth/v1/admin/users/'+$fixture.actorId) $admin
 if($r.status -eq 404){$cleanupConfirmed=$true}
 elseif($r.status -eq 200 -and ($r.content|ConvertFrom-Json).app_metadata.build35_hostile_fixture -eq $fixture.runId){
  $r=Api Delete ('/auth/v1/admin/users/'+$fixture.actorId) $admin
  $after=Api Get ('/auth/v1/admin/users/'+$fixture.actorId) $admin
  $cleanupConfirmed=$r.status -lt 300 -and $after.status -eq 404
  Record 'tag-verified synthetic identity cleanup' 'Admin delete succeeds; exact fixture absent afterward' @{deleteHttp=$r.status;afterHttp=$after.status} $cleanupConfirmed
 }else{$errors+=@{disposition='CLEANUP TAG MISMATCH OR AUTHORITY ERROR; no unverified delete';http=$r.status}}
 if($cleanupConfirmed){Remove-Item -LiteralPath $statePath}
 @{capturedAt=[DateTime]::UtcNow.ToString('o');projectRef=$ref;records=$records;errors=$errors;cleanupConfirmed=$cleanupConfirmed;expiryAtUtc=$fixture.expiresAtUtc;baseline='Auth200 and subject verified on October31 before natural expiry; retained fixture metadata';functionInventory='November2 read-only deployed inventory; does not attest application source digest';productionChanges=$false;providerCalls='No authenticated provider operation requested; gateway denial evidence only'}|ConvertTo-Json -Depth 10|Out-File -Encoding utf8 C:/b35readback1030/expired-jwt-staging-1102-results.json
 Write-Output ('Records='+$records.Count+'; cleanupConfirmed='+$cleanupConfirmed+'; errors='+$errors.Count)
 Remove-Variable keys,admin,anon,fixture -ErrorAction SilentlyContinue
}
