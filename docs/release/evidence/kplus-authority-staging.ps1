$ErrorActionPreference='Stop'
$ref='yzqjvdfgefveprobvvyw';$base='https://yzqjvdfgefveprobvvyw.supabase.co'
if($ref -ne 'yzqjvdfgefveprobvvyw' -or $base -ne 'https://yzqjvdfgefveprobvvyw.supabase.co'){throw 'Staging only'}
$keys=supabase projects api-keys --project-ref $ref --output json|ConvertFrom-Json
$admin=($keys|Where-Object {$_.name -eq 'service_role'}).api_key;$anon=($keys|Where-Object {$_.name -eq 'anon'}).api_key
if(!$admin -or !$anon){throw 'Keys unavailable'}
Add-Type -AssemblyName System.Net.Http
$client=[Net.Http.HttpClient]::new();$client.Timeout=[TimeSpan]::FromSeconds(20)
$run=[guid]::NewGuid().ToString('N');$actors=@();$results=@();$rpc='/rest/v1/rpc/reconcile_kplus_provider_transition'
function Api($method,$route,$token,$body=$null,$extra=@{}){
 $q=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($method),$base+$route)
 try{$q.Headers.Add('apikey',$(if($token -eq $admin){$admin}else{$anon}));$q.Headers.Add('Authorization','Bearer '+$token);$q.Headers.Add('Prefer','return=representation');foreach($k in $extra.Keys){$q.Headers.Add($k,[string]$extra[$k])}
 if($null -ne $body){$q.Content=[Net.Http.StringContent]::new([string]$body,[Text.Encoding]::UTF8,'application/json')}
 $r=$client.SendAsync($q).GetAwaiter().GetResult();try{return @{status=[int]$r.StatusCode;body=$r.Content.ReadAsStringAsync().GetAwaiter().GetResult()}}finally{$r.Dispose()}
 }finally{$q.Dispose()}
}
function Count-Rows($json){$v=$json|ConvertFrom-Json;if($null -eq $v){return 0};return @($v).Count}
function State($id){$g=Api 'GET' ('/rest/v1/kplus_entitlement_grants?select=user_id&user_id=eq.'+$id) $admin;$t=Api 'GET' ('/rest/v1/kplus_entitlement_transitions?select=user_id&user_id=eq.'+$id) $admin;if($g.status -ne 200 -or $t.status -ne 200){throw 'State read failed'};return @{grants=(Count-Rows $g.body);transitions=(Count-Rows $t.body)}}
function Record($probe,$expected,$actual,$ok){$script:results+=@{probeId=('B35-KPLUS-AUTH-'+('{0:d3}' -f ($script:results.Count+1)));feature='K+ trusted provider transition authority';boundary='reconcile_kplus_provider_transition RPC';sourceSha='c86bf3d052806c6105ce7830a03ac2b1501d34a1 / f4df2a5a525fb7ee1b22f16c9a4bc55c1c8831af; deployed Staging migration inventory separately recorded';sourceLocation='20260915030553_kplus_entitlement_authority.sql typed validation and grants; 20261004231628 reconciliation wrapper';environment='Tagged synthetic Staging only';probe=$probe;expected=$expected;actual=$actual;verdict=$(if($ok){'PASS'}else{'FAIL'});runId=$run;evidence='continuation-kplus-authority-staging.json';executionMethod='kplus-authority-staging.ps1; actual Auth/PostgREST/RPC/database';linkedDefectId=$null;repairReference=$null;reverificationStatus='Executed scoped assertion';limitation='No store/RevenueCat/signed-webhook/native purchase or other RPC claim'}}
try{
 foreach($label in @('A','B')){
  $email='build35-kplus-auth-'+$run+'-'+$label+'@example.invalid';$password=[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N')
  $r=Api 'POST' '/auth/v1/admin/users' $admin (@{email=$email;password=$password;email_confirm=$true;app_metadata=@{build35_hostile_fixture=$run}}|ConvertTo-Json -Depth 5)
  if($r.status -ge 300){throw 'Actor setup failed'};$id=($r.body|ConvertFrom-Json).id;$a=@{id=$id;label=$label;token=$null};$actors+=,$a
  $r=Api 'POST' '/auth/v1/token?grant_type=password' $anon (@{email=$email;password=$password}|ConvertTo-Json);if($r.status -ne 200){throw 'Synthetic login failed'};$a.token=($r.body|ConvertFrom-Json).access_token
  $r=Api 'GET' '/auth/v1/user' $a.token;Record ('signed actor '+$label+' baseline') 'Auth validates the actual actor' @{httpStatus=$r.status;actorMatches=(($r.body|ConvertFrom-Json).id -eq $id)} ($r.status -eq 200 -and ($r.body|ConvertFrom-Json).id -eq $id)
 }
 $a=$actors[0];$b=$actors[1];$fmt='yyyy-MM-ddTHH:mm:ss.fffZ';$now=[DateTime]::UtcNow
 $sha=[Security.Cryptography.SHA256]::Create();try{$digest=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($run)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
 $body=@{p_user_id=$a.id;p_provider='revenuecat';p_cause='provider_reconciliation';p_external_event_id=('b35_'+$run);p_provider_event_type='reconciliation_snapshot';p_provider_occurred_at=$now.AddMinutes(-1).ToString($fmt);p_environment='production';p_store='apple';p_product_id='fixture.apple.monthly';p_subscription_ref_digest=$digest;p_lifecycle_state='active';p_period_type='paid';p_period_starts_at=$now.AddDays(-30).ToString($fmt);p_expires_at=$now.AddDays(1).ToString($fmt);p_will_renew=$true;p_trial_ends_at=$null;p_grace_period_expires_at=$null;p_pause_resumes_at=$null;p_entitlement_key='k_plus'}
 foreach($case in @(@{name='anonymous';token=$anon;id=$a.id;headers=@{}},@{name='valid A own actor';token=$a.token;id=$a.id;headers=@{}},@{name='valid A targeting B';token=$a.token;id=$b.id;headers=@{}},@{name='caller-controlled role headers';token=$a.token;id=$a.id;headers=@{'x-supabase-role'='service_role';'x-user-id'=$b.id}},@{name='malformed JWT';token='not-a-jwt';id=$a.id;headers=@{}},@{name='tampered unsigned service claims';token='eyJhbGciOiJub25lIn0.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.';id=$a.id;headers=@{}})){
  $input=$body.Clone();$input.p_user_id=$case.id;$r=Api 'POST' $rpc $case.token ($input|ConvertTo-Json -Depth 8) $case.headers;$sa=State $a.id;$sb=State $b.id
  Record $case.name '401/403 before any grant or transition; valid JWTs do not gain service authority' @{httpStatus=$r.status;actorA=$sa;actorB=$sb} ($r.status -in @(401,403) -and $sa.grants -eq 0 -and $sa.transitions -eq 0 -and $sb.grants -eq 0 -and $sb.transitions -eq 0)
 }
 foreach($raw in @('','null','{','[]')){
  $r=Api 'POST' $rpc $admin $raw;$s=State $a.id
  Record ('invalid RPC JSON '+$(if($raw -eq ''){'empty'}else{$raw})) 'Controlled4xx, no synthetic mutation' @{httpStatus=$r.status;state=$s} ($r.status -ge 400 -and $r.status -lt 500 -and $s.grants -eq 0 -and $s.transitions -eq 0)
 }
 # Every typed RPC parameter gets a benign quote/OR injection string. No DDL,
 # dynamic SQL, raw query string, real payment or third-party call is used.
 foreach($parameter in @($body.Keys|Sort-Object)){
  $input=$body.Clone();$input[$parameter]="' OR '1'='1";$r=Api 'POST' $rpc $admin ($input|ConvertTo-Json -Depth 8);$s=State $a.id
  Record ('SQL injection parameter '+$parameter) 'Typed/enum/identifier validation rejects4xx; no synthetic state change' @{httpStatus=$r.status;state=$s} ($r.status -ge 400 -and $r.status -lt 500 -and $s.grants -eq 0 -and $s.transitions -eq 0)
 }
 $r=Api 'POST' $rpc $admin ($body|ConvertTo-Json -Depth 8);$s=State $a.id
 Record 'authorized service baseline' 'Valid normalized synthetic facts yield one grant and transition' @{httpStatus=$r.status;classification=($r.body|ConvertFrom-Json).classification;state=$s} ($r.status -eq 200 -and ($r.body|ConvertFrom-Json).classification -eq 'applied' -and $s.grants -eq 1 -and $s.transitions -eq 1)
 $r=Api 'POST' $rpc $admin ($body|ConvertTo-Json -Depth 8);$s=State $a.id
 Record 'service replay same event' 'Duplicate classification and exactly one grant/transition' @{httpStatus=$r.status;classification=($r.body|ConvertFrom-Json).classification;state=$s} ($r.status -eq 200 -and ($r.body|ConvertFrom-Json).classification -eq 'duplicate' -and $s.grants -eq 1 -and $s.transitions -eq 1)
}catch{$results+=@{probeId='B35-KPLUS-AUTH-HARNESS';probe='fixture execution';verdict='NOT TESTED';reason=$_.Exception.Message;runId=$run}}
finally{
 foreach($actor in $actors){try{$v=Api 'GET' ('/auth/v1/admin/users/'+$actor.id) $admin;if($v.status -eq 200 -and ($v.body|ConvertFrom-Json).app_metadata.build35_hostile_fixture -eq $run){$r=Api 'DELETE' ('/auth/v1/admin/users/'+$actor.id) $admin;$s=State $actor.id;Record ('tag-verified cleanup '+$actor.label) 'Auth deletion acknowledged; cascade leaves zero grant/transition rows' @{httpStatus=$r.status;remaining=$s} ($r.status -eq 200 -and $s.grants -eq 0 -and $s.transitions -eq 0)}else{$results+=@{probe='cleanup';verdict='NOT TESTED';reason='Tag verification failed; no delete';runId=$run}}}catch{$results+=@{probe='cleanup';verdict='NOT TESTED';reason='Cleanup unverified';runId=$run}}}
 $results|ConvertTo-Json -Depth 12|Out-File -Encoding utf8 C:/b35evidence1029/docs/release/evidence/continuation-kplus-authority-staging.json
 $results|ForEach-Object {[PSCustomObject]$_}|Select-Object probe,verdict
 $client.Dispose();Remove-Variable admin,anon,keys,actors,password -ErrorAction SilentlyContinue
}
