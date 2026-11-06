$ErrorActionPreference='Stop'
$ref='yzqjvdfgefveprobvvyw';$base='https://yzqjvdfgefveprobvvyw.supabase.co'
if($ref -ne 'yzqjvdfgefveprobvvyw' -or $base -match 'wyyuqfdxucjksghsmhry'){throw 'Staging only'}
$keys=supabase projects api-keys --project-ref $ref --output json|ConvertFrom-Json
$admin=($keys|Where-Object {$_.name -eq 'service_role'}).api_key;$anon=($keys|Where-Object {$_.name -eq 'anon'}).api_key
if(!$admin -or !$anon){throw 'Staging authority unavailable'}
$run=[guid]::NewGuid().ToString('N');$actors=@();$fixtures=@();$records=@();$errors=@()
function Api($method,$path,$token,$body=$null){
 $h=@{apikey=$anon;Authorization=('Bearer '+$token);Prefer='return=representation'};if($token -eq $admin){$h.apikey=$admin}
 $args=@{Method=$method;Uri=($base+$path);Headers=$h;ContentType='application/json';UseBasicParsing=$true;TimeoutSec=20};if($null -ne $body){$args.Body=($body|ConvertTo-Json -Depth 9 -Compress)}
 try{$r=Invoke-WebRequest @args;return @{status=[int]$r.StatusCode;content=$r.Content}}catch{if($_.Exception.Response){return @{status=[int]$_.Exception.Response.StatusCode;content=([IO.StreamReader]::new($_.Exception.Response.GetResponseStream())).ReadToEnd()}};throw}
}
function Rows($body){$j=$body|ConvertFrom-Json;if($null -eq $j){return 0};return @($j).Count}
function Record($table,$probe,$expected,$actual,$ok){$script:records+=@{probeId=('B35-OWNED-AUTH-'+($script:records.Count+1).ToString('000'));boundary=('public.'+$table);probe=$probe;expected=$expected;actual=$actual;verdict=$(if($ok){'PASS'}else{'FAIL'});environment='Real Staging PostgREST/Auth; tagged synthetic records only';runId=$run}}
try{
 foreach($label in @('A','B')){
  $pw=[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N');$email='build35-owned-auth-'+$run+'-'+$label+'@example.invalid'
  $r=Api Post '/auth/v1/admin/users' $admin @{email=$email;password=$pw;email_confirm=$true;app_metadata=@{build35_hostile_fixture=$run}}
  if($r.status -ge 300){throw 'Synthetic actor creation failed'};$a=@{id=($r.content|ConvertFrom-Json).id;token=$null};$actors+=$a
  $r=Api Post '/auth/v1/token?grant_type=password' $anon @{email=$email;password=$pw}
  if($r.status -ge 300){throw 'Synthetic actor login failed'};$a.token=($r.content|ConvertFrom-Json).access_token
 }
 $a=$actors[0];$b=$actors[1]
 foreach($t in @('looks','inspiration_items','saved_scans')){
  $payload=@{id=[guid]::NewGuid().ToString();user_id=$a.id}
  if($t -eq 'looks'){$payload.title='Build35 synthetic authority fixture'}
  if($t -eq 'inspiration_items'){$payload.storage_bucket='inspiration-images';$payload.storage_path=$a.id+'/synthetic-'+$run+'.jpg';$payload.note='Synthetic; no object uploaded'}
  if($t -eq 'saved_scans'){$payload.title='Build35 synthetic authority fixture';$payload.local_id=$run}
  $r=Api Post ('/rest/v1/'+$t) $a.token $payload
  if($r.status -ge 300 -or (Rows $r.content) -ne 1){$errors+=@{table=$t;disposition='SETUP ERROR';http=$r.status;response=$r.content};continue}
  $f=@{table=$t;id=$payload.id};$fixtures+=$f;$path='/rest/v1/'+$t+'?id=eq.'+$f.id
  $r=Api Get ($path+'&select=id') $a.token;Record $t 'owner read baseline' 'Own fixture readable while active' @{http=$r.status;rows=(Rows $r.content)} ($r.status -eq 200 -and (Rows $r.content) -eq 1)
  $r=Api Get ($path+'&select=id') $b.token;Record $t 'foreign read IDOR' 'No foreign rows' @{http=$r.status;rows=$(if($r.status -lt 300){Rows $r.content}else{0})} ($r.status -ge 400 -or (Rows $r.content) -eq 0)
  $r=Api Patch $path $b.token @{user_id=$b.id};$authority=Api Get ($path+'&select=user_id') $admin;$unchanged=@($authority.content|ConvertFrom-Json)[0].user_id -eq $a.id
  Record $t 'foreign update IDOR' 'Cannot rewrite synthetic owner' @{http=$r.status;ownerUnchanged=$unchanged} ($unchanged -and ($r.status -ge 400 -or (Rows $r.content) -eq 0))
  $r=Api Patch $path $a.token @{user_id=$b.id};$authority=Api Get ($path+'&select=user_id') $admin;$unchanged=@($authority.content|ConvertFrom-Json)[0].user_id -eq $a.id
  Record $t 'owner cannot transfer scope' 'WITH CHECK prevents reassignment to foreign actor' @{http=$r.status;ownerUnchanged=$unchanged} ($unchanged -and $r.status -ge 400)
  $foreign=@{};foreach($k in $payload.Keys){$foreign[$k]=$payload[$k]};$foreign.id=[guid]::NewGuid().ToString();$foreign.user_id=$b.id
  $r=Api Post ('/rest/v1/'+$t) $a.token $foreign;Record $t 'foreign insert IDOR' 'Cannot create under another synthetic owner' @{http=$r.status} ($r.status -ge 400)
  if($r.status -lt 300){$fixtures+=@{table=$t;id=$foreign.id}}
 }
 foreach($state in @('pending_deletion','locked')){
  $r=Api Patch ('/rest/v1/profiles?id=eq.'+$a.id) $admin @{account_status=$state;account_locked_at=$(if($state -eq 'locked'){[DateTime]::UtcNow.ToString('o')}else{$null})}
  if($r.status -ge 300 -or (Rows $r.content) -ne 1){throw 'Synthetic state transition failed'}
  foreach($f in $fixtures){
   $path='/rest/v1/'+$f.table+'?id=eq.'+$f.id
   $r=Api Get ($path+'&select=id') $a.token;Record $f.table ($state+' private read') 'Inactive account has no private data access with still-valid JWT' @{http=$r.status;rows=$(if($r.status -lt 300){Rows $r.content}else{0})} ($r.status -ge 400 -or (Rows $r.content) -eq 0)
   $payload=@{};if($f.table -eq 'inspiration_items'){$payload.note='Attempted inactive synthetic write'}else{$payload.title='Attempted inactive synthetic write'}
   $r=Api Patch $path $a.token $payload
   $check=Api Get $path $admin;$row=@($check.content|ConvertFrom-Json)[0];$changed=($row.note -eq 'Attempted inactive synthetic write' -or $row.title -eq 'Attempted inactive synthetic write')
   Record $f.table ($state+' private mutation') 'Inactive caller cannot mutate fixture' @{http=$r.status;rows=$(if($r.status -lt 300){Rows $r.content}else{0});mutationApplied=$changed} (!$changed -and ($r.status -ge 400 -or (Rows $r.content) -eq 0))
   if($changed){$reset=@{};if($f.table -eq 'inspiration_items'){$reset.note='Synthetic; no object uploaded'}else{$reset.title='Build35 synthetic authority fixture'};$r=Api Patch $path $admin $reset;if($r.status -ge 300){throw 'Synthetic reset failed'}}
  }
 }
}catch{$errors+=@{disposition='HARNESS OR SETUP ERROR';message=$_.Exception.Message;errorType=$_.Exception.GetType().Name}}
finally{
 foreach($f in $fixtures){$r=Api Delete ('/rest/v1/'+$f.table+'?id=eq.'+$f.id) $admin;if($r.status -ge 300){$errors+=@{disposition='SYNTHETIC ROW CLEANUP ERROR';table=$f.table;http=$r.status}}}
 foreach($a in $actors){$r=Api Get ('/auth/v1/admin/users/'+$a.id) $admin;if(($r.content|ConvertFrom-Json).app_metadata.build35_hostile_fixture -eq $run){$r=Api Delete ('/auth/v1/admin/users/'+$a.id) $admin;Record 'auth.users' 'tag-verified synthetic cleanup' 'Delete only run-tagged fixture identity' @{http=$r.status} ($r.status -lt 300)}else{$errors+=@{disposition='CLEANUP TAG MISMATCH; no delete'}}}
 @{capturedAt=[DateTime]::UtcNow.ToString('o');projectRef=$ref;records=$records;errors=$errors;productionChanges=$false;providerCalls=0;sourceComparison='Current mobile113a1895/canonical5df63c; deployed Staging migration/policy readback is separate runtime authority'}|ConvertTo-Json -Depth 10|Out-File -Encoding utf8 C:/b35readback1030/owned-table-authority-staging-results.json
 $records|Group-Object verdict|Select-Object Name,Count;Remove-Variable admin,anon,keys,pw -ErrorAction SilentlyContinue
}
