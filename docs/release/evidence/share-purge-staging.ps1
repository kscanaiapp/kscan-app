$ErrorActionPreference='Stop'
$ref='yzqjvdfgefveprobvvyw';$base='https://yzqjvdfgefveprobvvyw.supabase.co'
if($ref -ne 'yzqjvdfgefveprobvvyw' -or $base -match 'wyyuqfdxucjksghsmhry'){throw 'Staging identity mismatch'}
$keys=supabase projects api-keys --project-ref $ref --output json|ConvertFrom-Json
$admin=($keys|Where-Object {$_.name -eq 'service_role'}).api_key;$anon=($keys|Where-Object {$_.name -eq 'anon'}).api_key
if(!$admin -or !$anon){throw 'Staging keys unavailable'}
$run=[guid]::NewGuid().ToString('N');$actor=$null;$room=$null;$records=@();$errors=@();$purged=$false
function Api($method,$path,$token,$body=$null){
 $h=@{apikey=$anon;Authorization=('Bearer '+$token);Prefer='return=representation'};if($token -eq $admin){$h.apikey=$admin}
 $args=@{Method=$method;Uri=($base+$path);Headers=$h;ContentType='application/json';UseBasicParsing=$true;TimeoutSec=20};if($null -ne $body){$args.Body=$body}
 try{$r=Invoke-WebRequest @args;return @{status=[int]$r.StatusCode;content=$r.Content}}catch{if($_.Exception.Response){return @{status=[int]$_.Exception.Response.StatusCode;content=([IO.StreamReader]::new($_.Exception.Response.GetResponseStream())).ReadToEnd()}};throw}
}
function Record($probe,$expected,$actual,$ok){$script:records+=@{probeId=('B35-SHARE-PURGE-'+($script:records.Count+1).ToString('000'));probe=$probe;expected=$expected;actual=$actual;verdict=$(if($ok){'PASS'}else{'FAIL'});environment='Actual Staging Auth deletion and public-preview RPC; run-tagged synthetic identity only';runId=$run}}
function CountRows($body){$j=$body|ConvertFrom-Json;if($null -eq $j){return 0};return @($j).Count}
try{
 $pw=[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N');$email='build35-share-purge-'+$run+'@example.invalid'
 $r=Api Post '/auth/v1/admin/users' $admin (@{email=$email;password=$pw;email_confirm=$true;app_metadata=@{build35_hostile_fixture=$run}}|ConvertTo-Json -Depth 5)
 if($r.status -ge 300){throw ('Synthetic actor creation failed HTTP '+$r.status)};$actor=($r.content|ConvertFrom-Json).id
 $r=Api Post '/auth/v1/token?grant_type=password' $anon (@{email=$email;password=$pw}|ConvertTo-Json)
 if($r.status -ge 300){throw ('Synthetic actor login failed HTTP '+$r.status)};$token=($r.content|ConvertFrom-Json).access_token
 $room=[guid]::NewGuid().ToString()
 $r=Api Post '/rest/v1/dressing_rooms' $token (@{id=$room;user_id=$actor;title=('Synthetic purge '+$run)}|ConvertTo-Json)
 if($r.status -ge 300){throw ('Synthetic room setup failed HTTP '+$r.status)}
 $r=Api Post '/rest/v1/rpc/create_or_get_room_share' $token (@{p_room_id=$room}|ConvertTo-Json)
 if($r.status -ge 300){throw ('Synthetic public share setup failed HTTP '+$r.status)};$share=$r.content|ConvertFrom-Json
 if($share -notmatch '^[0-9a-f-]{36}$'){throw 'Unexpected share token shape'};$shareBody=@{p_share_token=$share}|ConvertTo-Json
 foreach($state in @('active','pending_deletion','locked')){
  if($state -ne 'active'){$r=Api Patch ('/rest/v1/profiles?id=eq.'+$actor) $admin (@{account_status=$state;account_locked_at=$(if($state -eq 'locked'){[DateTime]::UtcNow.ToString('o')}else{$null})}|ConvertTo-Json);if($r.status -ge 300 -or (CountRows $r.content) -ne 1){throw 'Synthetic lifecycle update failed'}}
  $r=Api Post '/rest/v1/rpc/get_public_room_preview' $anon $shareBody;$j=$r.content|ConvertFrom-Json
  Record ($state+' owner public link') 'Owner-confirmed contract: active public links remain viewable until revoked or owner purge' @{http=$r.status;previewStatus=$j.status} ($r.status -eq 200 -and $j.status -eq 'available')
  if($state -ne 'active'){$r=Api Get ('/rest/v1/dressing_rooms?select=id&id=eq.'+$room) $token;$n=CountRows $r.content;Record ($state+' private room access') 'Retained JWT does not return private room rows' @{http=$r.status;rows=$n} ($r.status -ge 400 -or $n -eq 0)}
 }
 $r=Api Get ('/auth/v1/admin/users/'+$actor) $admin
 if(($r.content|ConvertFrom-Json).app_metadata.build35_hostile_fixture -ne $run){throw 'Fixture tag mismatch; no purge performed'}
 $r=Api Delete ('/auth/v1/admin/users/'+$actor) $admin;$purged=$r.status -lt 300
 Record 'tag-verified synthetic Auth purge' 'Hard-delete only the exact run-tagged synthetic identity; no account-deletion worker/provider action' @{http=$r.status} $purged
 if(!$purged){throw 'Synthetic Auth purge failed; cannot assert post-purge behavior'}
 $r=Api Post '/rest/v1/rpc/get_public_room_preview' $anon $shareBody;$j=$r.content|ConvertFrom-Json
 Record 'unrevoked public link replay after purge' 'Previously active capability becomes unavailable after owner hard deletion/cascade' @{http=$r.status;previewStatus=$j.status} ($r.status -eq 200 -and $j.status -eq 'unavailable')
 $r=Api Get ('/rest/v1/room_shares?select=id&share_token=eq.'+$share) $admin;$n=CountRows $r.content
 Record 'share authority after purge' 'No remaining public share authority row' @{http=$r.status;rows=$n} ($r.status -eq 200 -and $n -eq 0)
 $r=Api Get ('/rest/v1/dressing_rooms?select=id&id=eq.'+$room) $admin;$n=CountRows $r.content
 Record 'synthetic room after purge' 'No remaining synthetic room after cascade' @{http=$r.status;rows=$n} ($r.status -eq 200 -and $n -eq 0)
 $r=Api Get ('/auth/v1/admin/users/'+$actor) $admin
 Record 'synthetic identity absence' 'Auth admin lookup explicitly denies deleted identity' @{http=$r.status} ($r.status -ge 400)
}catch{$errors+=@{disposition='HARNESS OR SETUP ERROR';message=$_.Exception.Message;errorType=$_.Exception.GetType().Name}}
finally{
 if(!$purged -and $room -and $actor){$r=Api Get ('/rest/v1/dressing_rooms?select=user_id&id=eq.'+$room) $admin;if((($r.content|ConvertFrom-Json)|Select-Object -First 1).user_id -eq $actor){$null=Api Delete ('/rest/v1/dressing_rooms?id=eq.'+$room) $admin}}
 if(!$purged -and $actor){$r=Api Get ('/auth/v1/admin/users/'+$actor) $admin;if(($r.content|ConvertFrom-Json).app_metadata.build35_hostile_fixture -eq $run){$r=Api Delete ('/auth/v1/admin/users/'+$actor) $admin;Record 'fallback tagged synthetic cleanup' 'Delete only verified fixture identity after failed test setup' @{http=$r.status} ($r.status -lt 300)}}
 @{capturedAt=[DateTime]::UtcNow.ToString('o');projectRef=$ref;records=$records;errors=$errors;ownerContract='Keep public links active until revoked or the account is purged';limitations='Exercises actual Auth hard-delete/cascades for an empty synthetic room, not the full delayed deletion worker, storage media purge or third-party deletion propagation.';productionChanges=$false;providerCalls=0}|ConvertTo-Json -Depth 10|Out-File -Encoding utf8 C:/b35readback1030/share-purge-staging-results.json
 $records|Select-Object probe,verdict
 Remove-Variable admin,anon,keys,pw,token,share,shareBody -ErrorAction SilentlyContinue
}
