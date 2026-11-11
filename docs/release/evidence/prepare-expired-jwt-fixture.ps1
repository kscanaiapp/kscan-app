$ErrorActionPreference='Stop'
$ref='yzqjvdfgefveprobvvyw';$base='https://yzqjvdfgefveprobvvyw.supabase.co';$id=$null;$saved=$false;$token=$null
if($ref -ne 'yzqjvdfgefveprobvvyw' -or $base -match 'wyyuqfdxucjksghsmhry'){throw 'Staging only'}
if(Test-Path -LiteralPath C:/b35readback1030/staging-expiry-fixture.dpapi){throw 'Existing expiry fixture must be reconciled first'}
$keys=supabase projects api-keys --project-ref $ref --output json|ConvertFrom-Json
$admin=($keys|Where-Object {$_.name -eq 'service_role'}).api_key;$anon=($keys|Where-Object {$_.name -eq 'anon'}).api_key
if(!$admin -or !$anon){throw 'Staging authority unavailable'}
$run=[guid]::NewGuid().ToString('N')
function Api($method,$path,$credential,$body=$null){
 $h=@{apikey=$anon;Authorization=('Bearer '+$credential)};if($credential -eq $admin){$h.apikey=$admin}
 $args=@{Method=$method;Uri=($base+$path);Headers=$h;ContentType='application/json';UseBasicParsing=$true;TimeoutSec=20};if($null -ne $body){$args.Body=$body}
 try{$r=Invoke-WebRequest @args;return @{status=[int]$r.StatusCode;content=$r.Content}}catch{if($_.Exception.Response){return @{status=[int]$_.Exception.Response.StatusCode;content=([IO.StreamReader]::new($_.Exception.Response.GetResponseStream())).ReadToEnd()}};throw}
}
try{
 $pw=[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N');$email='build35-expiry-'+$run+'@example.invalid'
 $r=Api Post '/auth/v1/admin/users' $admin (@{email=$email;password=$pw;email_confirm=$true;app_metadata=@{build35_hostile_fixture=$run}}|ConvertTo-Json -Depth 5)
 if($r.status -ge 300){throw 'Synthetic creation failed'};$id=($r.content|ConvertFrom-Json).id
 $r=Api Post '/auth/v1/token?grant_type=password' $anon (@{email=$email;password=$pw}|ConvertTo-Json)
 if($r.status -ge 300){throw 'Synthetic login failed'};$token=($r.content|ConvertFrom-Json).access_token
 $r=Api Get '/auth/v1/user' $token
 if($r.status -ne 200 -or ($r.content|ConvertFrom-Json).id -ne $id){throw 'Verified-user baseline failed'}
 $payload=$token.Split('.')[1].Replace('-','+').Replace('_','/');while($payload.Length%4){$payload+='='}
 $claims=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))|ConvertFrom-Json
 if($claims.sub -ne $id){throw 'Wrong synthetic token subject'}
 $expires=[DateTimeOffset]::FromUnixTimeSeconds([long]$claims.exp).UtcDateTime
 $state=@{projectRef=$ref;actorId=$id;runId=$run;accessToken=$token;expiresAtUtc=$expires.ToString('o')}|ConvertTo-Json
 Add-Type -AssemblyName System.Security
 $plain=[Text.Encoding]::UTF8.GetBytes($state)
 $encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 [IO.File]::WriteAllBytes('C:/b35readback1030/staging-expiry-fixture.dpapi',$encrypted);[Array]::Clear($plain,0,$plain.Length)
 $saved=$true
 @{createdAtUtc=[DateTime]::UtcNow.ToString('o');projectRef=$ref;runId=$run;expiresAtUtc=$expires.ToString('o');baselineAuthStatus=200;state='PENDING NATURAL EXPIRY';privateState='C:/b35readback1030/staging-expiry-fixture.dpapi';protection='Windows DPAPI CurrentUser; no plaintext token or password persisted';scope='One empty tagged synthetic Staging identity, no provider/purchase/deletion worker call. Finish expired JWT probes then tag-verified cleanup.'}|ConvertTo-Json|Out-File -Encoding utf8 C:/b35readback1030/staging-expiry-fixture-metadata.json
 Write-Output ('Synthetic JWT expiry fixture prepared; expiry UTC '+$expires.ToString('o'))
}finally{
 if(!$saved -and $id){$r=Api Get ('/auth/v1/admin/users/'+$id) $admin;if(($r.content|ConvertFrom-Json).app_metadata.build35_hostile_fixture -eq $run){$null=Api Delete ('/auth/v1/admin/users/'+$id) $admin}}
 Remove-Variable admin,anon,keys,pw,token,state,payload,claims -ErrorAction SilentlyContinue
}
