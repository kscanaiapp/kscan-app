$ErrorActionPreference='Stop'
$ref='yzqjvdfgefveprobvvyw';$base='https://yzqjvdfgefveprobvvyw.supabase.co'
if($ref -ne 'yzqjvdfgefveprobvvyw' -or $base -ne 'https://yzqjvdfgefveprobvvyw.supabase.co'){throw 'Staging only'}
$out='C:/b35evidence1029/docs/release/evidence/continuation-kplus-concurrency-staging.json'
$keys=supabase projects api-keys --project-ref $ref --output json|ConvertFrom-Json
$admin=($keys|Where-Object {$_.name -eq 'service_role'}).api_key;$anon=($keys|Where-Object {$_.name -eq 'anon'}).api_key
if(!$admin -or !$anon){throw 'Staging keys unavailable'}
Add-Type -AssemblyName System.Net.Http
$http=[System.Net.Http.HttpClient]::new();$http.Timeout=[TimeSpan]::FromSeconds(25)
$run=[guid]::NewGuid().ToString('N');$actors=@();$results=@()
function Begin-Api($method,$route,$token,$body=$null){
 $req=[System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($method),$base+$route)
 $req.Headers.Add('apikey',$(if($token -eq $admin){$admin}else{$anon}));$req.Headers.Add('Authorization','Bearer '+$token);$req.Headers.Add('Prefer','return=representation')
 if($null -ne $body){$req.Content=[System.Net.Http.StringContent]::new(($body|ConvertTo-Json -Depth 8 -Compress),[Text.Encoding]::UTF8,'application/json')}
 return @{request=$req;task=$http.SendAsync($req)}
}
function Finish-Api($job){
 try{$response=$job.task.GetAwaiter().GetResult();try{$content=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult();return @{status=[int]$response.StatusCode;body=$content}}finally{$response.Dispose()}}finally{$job.request.Dispose()}
}
function Api($method,$route,$token,$body=$null){return Finish-Api (Begin-Api $method $route $token $body)}
function Count-Rows($json){$v=$json|ConvertFrom-Json;if($null -eq $v){return 0};return @($v).Count}
function Record($probe,$expected,$actual,$verdict,$defect=$null){
 $script:results+=@{probeId=('B35-KPLUS-STAGING-'+('{0:d3}' -f ($script:results.Count+1)));feature='K+ provider transition authority';boundary='service-only reconcile_kplus_provider_transition RPC';sourceSha='c86bf3d052806c6105ce7830a03ac2b1501d34a1 / f4df2a5a525fb7ee1b22f16c9a4bc55c1c8831af; live Staging migration versions separately recorded';sourceLocation='supabase/migrations/20261004231628_fix_kplus_reconciliation_uuid_selection.sql; existing transition authority';environment='Synthetic tagged Staging accounts only';probe=$probe;expected=$expected;actual=$actual;verdict=$verdict;runId=$run;evidence='continuation-kplus-concurrency-staging.json';executionMethod='kplus-concurrency-staging.ps1 concurrent HttpClient RPC requests';linkedDefectId=$defect;repairReference=$null;reverificationStatus='Actual database RPC result; no store/webhook/provider claim';limitation='Admin-simulated normalized provider facts. No store transaction, RevenueCat HTTP call or signed-webhook handler executed.'}
}
function New-Actor($label){
 $r=Api 'POST' '/auth/v1/admin/users' $admin @{email=('build35-kplus-'+$run+'-'+$label+'@example.invalid');password=([guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N'));email_confirm=$true;app_metadata=@{build35_hostile_fixture=$run}}
 if($r.status -ge 300){throw 'Synthetic actor setup failed'};$id=($r.body|ConvertFrom-Json).id;if(!$id){throw 'Missing fixture actor ID'}
 $a=@{id=$id;label=$label};$script:actors+=,$a;return $a
}
function Digest($text){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Transition($actor,$event,$digest,$state,$occurred,$start,$end){
 return @{p_user_id=$actor.id;p_provider='revenuecat';p_cause='provider_reconciliation';p_external_event_id=('b35_'+$run+'_'+$event);p_provider_event_type='reconciliation_snapshot';p_provider_occurred_at=$occurred;p_environment='production';p_store='apple';p_product_id='fixture.apple.monthly';p_subscription_ref_digest=$digest;p_lifecycle_state=$state;p_period_type='paid';p_period_starts_at=$start;p_expires_at=$end;p_will_renew=($state -eq 'active');p_trial_ends_at=$null;p_grace_period_expires_at=$null;p_pause_resumes_at=$null;p_entitlement_key='k_plus'}
}
function State($actor){
 $g=Api 'GET' ('/rest/v1/kplus_entitlement_grants?select=expires_at,revoked_at&user_id=eq.'+$actor.id+'&source=eq.store_subscription') $admin
 $t=Api 'GET' ('/rest/v1/kplus_entitlement_transitions?select=user_id&user_id=eq.'+$actor.id) $admin
 if($g.status -ne 200 -or $t.status -ne 200){throw 'Synthetic state read failed'}
 $grants=$g.body|ConvertFrom-Json;$expires=$null;$revoked=0
 foreach($grant in @($grants)){if($null -eq $grant){continue};$expires=$grant.expires_at;if($grant.revoked_at){$revoked++}}
 return @{grants=(Count-Rows $g.body);transitions=(Count-Rows $t.body);expires=$expires;revoked=$revoked}
}
function Pair($one,$two){
 $j1=Begin-Api 'POST' '/rest/v1/rpc/reconcile_kplus_provider_transition' $admin $one
 $firstCompletedAtSecondDispatch=$j1.task.IsCompleted
 $j2=Begin-Api 'POST' '/rest/v1/rpc/reconcile_kplus_provider_transition' $admin $two
 $r1=Finish-Api $j1;$r2=Finish-Api $j2
 return @{httpStatuses=@($r1.status,$r2.status);overlappingClientTasks=(-not $firstCompletedAtSecondDispatch);classifications=@(($r1.body|ConvertFrom-Json).classification,($r2.body|ConvertFrom-Json).classification)}
}
try{
 $now=[DateTime]::UtcNow;$old=$now.AddMinutes(-2).ToString('o');$newer=$now.AddMinutes(-1).ToString('o');$activeEnd=$now.AddDays(1).ToString('o');$expiredEnd=$now.AddDays(-1).ToString('o')
 foreach($case in @('duplicate','distinct-reference','newer-expiration','newer-renewal')){
  $a=New-Actor $case;$baseline=State $a
  if($baseline.grants -ne 0 -or $baseline.transitions -ne 0){throw 'Fixture baseline not empty'}
  $d1=Digest ($run+':'+$case+':one');$d2=Digest ($run+':'+$case+':two')
  $one=Transition $a ($case+'_one') $d1 'active' $old $old $activeEnd
  $two=Transition $a ($case+'_two') $d2 'active' $old $old $activeEnd
  $wantTransitions=2;$expectedExpiry=$activeEnd
  if($case -eq 'duplicate'){$two=$one;$wantTransitions=1}
  if($case -eq 'newer-expiration'){$one=Transition $a ($case+'_newer') $d1 'expired' $newer $old $expiredEnd;$expectedExpiry=$expiredEnd}
  if($case -eq 'newer-renewal'){$one=Transition $a ($case+'_newer') $d1 'active' $newer $old $activeEnd;$two=Transition $a ($case+'_older') $d2 'expired' $old $old $expiredEnd}
  $pair=Pair $one $two;$state=State $a
  $ok=($pair.httpStatuses[0] -eq 200 -and $pair.httpStatuses[1] -eq 200 -and $state.grants -eq 1 -and $state.transitions -eq $wantTransitions -and $state.revoked -eq 0 -and [DateTime]::Parse($state.expires).ToUniversalTime() -eq [DateTime]::Parse($expectedExpiry).ToUniversalTime())
  $verdict=if(!$pair.overlappingClientTasks){'NOT TESTED'}elseif($ok){'PASS'}else{'FAIL'}
  Record ('concurrent '+$case) ('One grant, '+$wantTransitions+' transition rows, expected provider chronology expiry, no revoke; baseline empty') @{baseline=$baseline;dispatch=$pair;final=$state;expectedExpiry=$expectedExpiry} $verdict
 }
 $a=New-Actor 'isolated-A';$b=New-Actor 'isolated-B'
 $pair=Pair (Transition $a 'actor_A' (Digest ($run+':actor_A')) 'active' $old $old $activeEnd) (Transition $b 'actor_B' (Digest ($run+':actor_B')) 'active' $old $old $activeEnd)
 $sa=State $a;$sb=State $b;$ok=($pair.httpStatuses[0] -eq 200 -and $pair.httpStatuses[1] -eq 200 -and $sa.grants -eq 1 -and $sb.grants -eq 1 -and $sa.transitions -eq 1 -and $sb.transitions -eq 1)
 Record 'two synthetic actors concurrent independent transitions' 'One grant/transition for each actor; no merged actor state' @{dispatch=$pair;actorA=$sa;actorB=$sb} $(if(!$pair.overlappingClientTasks){'NOT TESTED'}elseif($ok){'PASS'}else{'FAIL'})
}catch{
 Record 'fixture execution' 'Complete controlled fixture and asserted state' @{status='INVALID HARNESS OR UNEXPECTED RESPONSE';errorType=$_.Exception.GetType().Name;message=$_.Exception.Message} 'NOT TESTED'
}finally{
 foreach($actor in $actors){
  try{
   $v=Api 'GET' ('/auth/v1/admin/users/'+$actor.id) $admin
   if($v.status -eq 200 -and ($v.body|ConvertFrom-Json).app_metadata.build35_hostile_fixture -eq $run){
    $r=Api 'DELETE' ('/auth/v1/admin/users/'+$actor.id) $admin;$post=State $actor
    Record ('tag-verified cleanup '+$actor.label) 'Acknowledged synthetic Auth deletion, zero grant/transition rows after cascade' @{httpStatus=$r.status;remaining=$post} $(if($r.status -eq 200 -and $post.grants -eq 0 -and $post.transitions -eq 0){'PASS'}else{'FAIL'})
   }else{Record ('cleanup '+$actor.label) 'Tag must match before delete' @{status='NO DELETE; TAG OR IDENTITY CHECK FAILED'} 'NOT TESTED'}
  }catch{Record ('cleanup '+$actor.label) 'Verified cleanup completes' @{status='UNVERIFIED';errorType=$_.Exception.GetType().Name} 'NOT TESTED'}
 }
 $results|ConvertTo-Json -Depth 12|Out-File -Encoding utf8 $out
 $results|Select-Object probe,verdict
 $http.Dispose();Remove-Variable admin,anon,keys -ErrorAction SilentlyContinue
}
