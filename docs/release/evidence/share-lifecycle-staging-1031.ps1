$ErrorActionPreference='Stop'
$ref='yzqjvdfgefveprobvvyw';$base='https://yzqjvdfgefveprobvvyw.supabase.co'
if($ref -ne 'yzqjvdfgefveprobvvyw' -or $base -match 'wyyuqfdxucjksghsmhry'){throw 'Staging identity mismatch'}
$keys=supabase projects api-keys --project-ref $ref --output json|ConvertFrom-Json
$admin=($keys|Where-Object {$_.name -eq 'service_role'}).api_key;$anon=($keys|Where-Object {$_.name -eq 'anon'}).api_key
if(!$admin -or !$anon){throw 'Staging keys unavailable'}
$run=[guid]::NewGuid().ToString('N');$actors=@();$room=$null;$records=@();$observations=@()
function Api($method,$path,$token,$body=$null){
 $h=@{apikey=$anon;Authorization=('Bearer '+$token);Prefer='return=representation'};if($token -eq $admin){$h.apikey=$admin}
 $args=@{Method=$method;Uri=($base+$path);Headers=$h;ContentType='application/json';UseBasicParsing=$true;TimeoutSec=20};if($null -ne $body){$args.Body=$body}
 try{$r=Invoke-WebRequest @args;return @{status=[int]$r.StatusCode;content=$r.Content}}catch{if($_.Exception.Response){return @{status=[int]$_.Exception.Response.StatusCode;content=([IO.StreamReader]::new($_.Exception.Response.GetResponseStream())).ReadToEnd()}};throw}
}
function Record($probe,$expected,$actual,$ok){$script:records+=@{probeId=('B35-SHARE-LIFE-'+($script:records.Count+1).ToString('000'));probe=$probe;expected=$expected;actual=$actual;verdict=$(if($ok){'PASS'}else{'FAIL'});environment='Actual Staging RPC/RLS; tagged ephemeral synthetic actors only';runId=$run}}
try{
 foreach($label in @('A','B')){
  $pw=[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N');$email='build35-share-lifecycle-'+$run+'-'+$label+'@example.invalid'
  $r=Api Post '/auth/v1/admin/users' $admin (@{email=$email;password=$pw;email_confirm=$true;app_metadata=@{build35_hostile_fixture=$run}}|ConvertTo-Json -Depth 5)
  if($r.status -ge 300){throw ('Synthetic actor creation failed HTTP '+$r.status)}
  $a=@{id=($r.content|ConvertFrom-Json).id;token=$null};$actors+=$a
  $r=Api Post '/auth/v1/token?grant_type=password' $anon (@{email=$email;password=$pw}|ConvertTo-Json)
  if($r.status -ge 300){throw ('Synthetic actor login failed HTTP '+$r.status)};$a.token=($r.content|ConvertFrom-Json).access_token
 }
 $owner=$actors[0];$member=$actors[1];$room=[guid]::NewGuid().ToString()
 $r=Api Post '/rest/v1/dressing_rooms' $owner.token (@{id=$room;user_id=$owner.id;title=('Synthetic share lifecycle '+$run)}|ConvertTo-Json)
 if($r.status -ge 300){throw ('Synthetic room creation failed HTTP '+$r.status)}
 $r=Api Post '/rest/v1/rpc/create_or_get_room_share' $owner.token (@{p_room_id=$room}|ConvertTo-Json)
 if($r.status -ge 300){throw ('Share creation failed HTTP '+$r.status)};$share=$r.content|ConvertFrom-Json
 if($share -notmatch '^[0-9a-f-]{36}$'){throw 'Share token shape mismatch'}
 $shareBody=@{p_share_token=$share}|ConvertTo-Json
 $r=Api Post '/rest/v1/rpc/get_public_room_preview' $anon $shareBody;$j=$r.content|ConvertFrom-Json
 Record 'active public link baseline' 'Anonymous public preview available for owner-created active link' @{http=$r.status;status=$j.status} ($r.status -eq 200 -and $j.status -eq 'available')
 $r=Api Post '/rest/v1/rpc/join_room_via_share_token' $member.token $shareBody
 if($r.status -ge 300){throw ('Membership join failed HTTP '+$r.status)}
 $r=Api Post '/rest/v1/rpc/resolve_dressing_room_collaboration_access' $member.token (@{p_room_id=$room}|ConvertTo-Json);$ok=($r.content|ConvertFrom-Json).ok
 Record 'active collaboration baseline' 'Joined member has authoritative collaboration access' @{http=$r.status;ok=$ok} ($r.status -eq 200 -and $ok -eq $true)
 $r=Api Patch ('/rest/v1/dressing_room_participants?dressing_room_id=eq.'+$room+'&user_id=eq.'+$member.id) $admin (@{left_at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json)
 if($r.status -ge 300 -or @($r.content|ConvertFrom-Json).Count -ne 1){throw 'Tagged membership removal setup failed'}
 $r=Api Post '/rest/v1/rpc/resolve_dressing_room_collaboration_access' $member.token (@{p_room_id=$room}|ConvertTo-Json);$ok=($r.content|ConvertFrom-Json).ok
 Record 'removed member private access' 'Removed member no longer has collaboration access' @{http=$r.status;ok=$ok} ($r.status -eq 200 -and $ok -eq $false)
 $r=Api Post '/rest/v1/rpc/get_public_room_preview' $member.token $shareBody;$j=$r.content|ConvertFrom-Json
 Record 'removed member public capability' 'Explicit UI contract: anyone retaining active public link may view preview; separate link revocation required' @{http=$r.status;status=$j.status} ($r.status -eq 200 -and $j.status -eq 'available')
 foreach($state in @('pending_deletion','locked')){
  $r=Api Patch ('/rest/v1/profiles?id=eq.'+$owner.id) $admin (@{account_status=$state;account_locked_at=$(if($state -eq 'locked'){[DateTime]::UtcNow.ToString('o')}else{$null})}|ConvertTo-Json)
  if($r.status -ge 300 -or @($r.content|ConvertFrom-Json).Count -ne 1){throw 'Tagged owner lifecycle setup failed'}
  $r=Api Get ('/rest/v1/dressing_rooms?select=id&id=eq.'+$room) $owner.token;$n=0;$rows=$r.content|ConvertFrom-Json;if($null -ne $rows){$n=@($rows).Count}
  Record ($state+' owner private room read') 'Restricted account receives no private room rows despite retained JWT' @{http=$r.status;rows=$n} ($r.status -ge 400 -or $n -eq 0)
  $r=Api Post '/rest/v1/rpc/get_public_room_preview' $anon $shareBody;$j=$r.content|ConvertFrom-Json
  $observations+=@{ownerState=$state;boundary='Anonymous public room preview';http=$r.status;previewStatus=$j.status;disposition='OBSERVED; public capability behavior recorded, owner-deactivation public-preview contract not established. Not classified as a security finding or PASS.'}
 }
 $r=Api Patch ('/rest/v1/profiles?id=eq.'+$owner.id) $admin '{"account_status":"active","account_locked_at":null}'
 if($r.status -ge 300){throw 'Restore synthetic owner before revocation failed'}
 $r=Api Post '/rest/v1/rpc/revoke_room_share' $owner.token (@{p_room_id=$room}|ConvertTo-Json)
 if($r.status -ge 300){throw 'Owned public share revocation failed'}
 $r=Api Post '/rest/v1/rpc/get_public_room_preview' $anon $shareBody;$j=$r.content|ConvertFrom-Json
 Record 'revoked public capability replay' 'Previously available public token now unavailable' @{http=$r.status;status=$j.status} ($r.status -eq 200 -and $j.status -eq 'unavailable')
}catch{$observations+=@{disposition='HARNESS OR SETUP ERROR';message=$_.Exception.Message;errorType=$_.Exception.GetType().Name}}
finally{
 if($room -and $actors.Count -gt 0){$r=Api Get ('/rest/v1/dressing_rooms?select=user_id&id=eq.'+$room) $admin;if((($r.content|ConvertFrom-Json)|Select-Object -First 1).user_id -eq $actors[0].id){$r=Api Delete ('/rest/v1/dressing_rooms?id=eq.'+$room) $admin;Record 'tagged room cleanup' 'Only verified synthetic owned room removed' @{http=$r.status} ($r.status -lt 300)}}
 foreach($a in $actors){$r=Api Get ('/auth/v1/admin/users/'+$a.id) $admin;if(($r.content|ConvertFrom-Json).app_metadata.build35_hostile_fixture -eq $run){$r=Api Delete ('/auth/v1/admin/users/'+$a.id) $admin;Record 'tag-verified actor cleanup' 'Only run-tagged synthetic identity deleted' @{http=$r.status} ($r.status -lt 300)}else{$observations+=@{disposition='CLEANUP TAG MISMATCH; no deletion'}}}
 @{capturedAt=[DateTime]::UtcNow.ToString('o');projectRef=$ref;records=$records;observations=$observations;sourceContract='Source mobile50387a2b; actual deployed Staging policies/RPCs, not local deployment parity certification';productionChanges=$false;providerCalls=0}|ConvertTo-Json -Depth 10|Out-File -Encoding utf8 C:/b35readback1030/share-lifecycle-staging-results.json
 $records|Select-Object probe,verdict;$observations|Select-Object ownerState,previewStatus,disposition
 Remove-Variable admin,anon,keys,pw,share,shareBody -ErrorAction SilentlyContinue
}
