$ErrorActionPreference='Stop'
$ref='yzqjvdfgefveprobvvyw';$base='https://yzqjvdfgefveprobvvyw.supabase.co'
if($ref -ne 'yzqjvdfgefveprobvvyw' -or $base -match 'wyyuqfdxucjksghsmhry'){throw 'Staging only'}
$keys=supabase projects api-keys --project-ref $ref --output json|ConvertFrom-Json
$admin=($keys|Where-Object {$_.name -eq 'service_role'}).api_key;$anon=($keys|Where-Object {$_.name -eq 'anon'}).api_key
if(!$admin -or !$anon){throw 'Staging authority unavailable'}
$run=[guid]::NewGuid().ToString('N');$actors=@();$records=@();$errors=@()
function Api($method,$path,$token,$body=$null,$extra=@{}){
 $h=@{apikey=$anon;Authorization=('Bearer '+$token);Prefer='return=representation'};if($token -eq $admin){$h.apikey=$admin}
 foreach($k in $extra.Keys){if($k -in @('Authorization','apikey')){throw 'Credential override prohibited'};$h[$k]=$extra[$k]}
 $args=@{Method=$method;Uri=($base+$path);Headers=$h;ContentType='application/json';UseBasicParsing=$true;TimeoutSec=20};if($null -ne $body){$args.Body=$body}
 try{$r=Invoke-WebRequest @args;return @{status=[int]$r.StatusCode;content=$r.Content}}catch{if($_.Exception.Response){return @{status=[int]$_.Exception.Response.StatusCode;content=([IO.StreamReader]::new($_.Exception.Response.GetResponseStream())).ReadToEnd()}};throw}
}
function Rows($body){$j=$body|ConvertFrom-Json;if($null -eq $j){return 0};return @($j).Count}
function Record($probe,$expected,$actual,$ok){$script:records+=@{probeId=('B35-PROFILE-AUTH-'+($script:records.Count+1).ToString('000'));probe=$probe;expected=$expected;actual=$actual;verdict=$(if($ok){'PASS'}else{'FAIL'});environment='Real Staging PostgREST/Auth, tagged synthetic actors only';runId=$run}}
function ReadAdmin($id){$r=Api Get ('/rest/v1/profiles?select=id,account_status,account_locked_at&id=eq.'+$id) $admin;if($r.status -ne 200 -or (Rows $r.content) -ne 1){throw 'Synthetic profile authority lookup failed'};return @($r.content|ConvertFrom-Json)[0]}
try{
 foreach($label in @('A','B')){
  $pw=[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N');$email='build35-profile-authority-'+$run+'-'+$label+'@example.invalid'
  $r=Api Post '/auth/v1/admin/users' $admin (@{email=$email;password=$pw;email_confirm=$true;app_metadata=@{build35_hostile_fixture=$run}}|ConvertTo-Json -Depth 5)
  if($r.status -ge 300){throw 'Synthetic actor creation failed'};$a=@{id=($r.content|ConvertFrom-Json).id;token=$null};$actors+=$a
  $r=Api Post '/auth/v1/token?grant_type=password' $anon (@{email=$email;password=$pw}|ConvertTo-Json)
  if($r.status -ge 300){throw 'Synthetic actor login failed'};$a.token=($r.content|ConvertFrom-Json).access_token
 }
 $a=$actors[0];$b=$actors[1]
 foreach($actor in $actors){$r=Api Get ('/rest/v1/profiles?select=id&id=eq.'+$actor.id) $actor.token;Record 'own synthetic profile read baseline' 'Exactly own profile row' @{http=$r.status;rows=(Rows $r.content)} ($r.status -eq 200 -and (Rows $r.content) -eq 1)}
 foreach($state in @('active','pending_deletion','locked')){
  $r=Api Patch ('/rest/v1/profiles?id=eq.'+$a.id) $admin (@{account_status=$state;account_locked_at=$(if($state -eq 'locked'){[DateTime]::UtcNow.ToString('o')}else{$null})}|ConvertTo-Json)
  if($r.status -ge 300 -or (Rows $r.content) -ne 1){throw 'Synthetic lifecycle setup failed'}
  $before=ReadAdmin $a.id
  $r=Api Patch ('/rest/v1/profiles?id=eq.'+$a.id) $a.token '{"account_status":"active","account_locked_at":null}'
  $after=ReadAdmin $a.id;$unchanged=$after.account_status -eq $before.account_status -and $after.account_locked_at -eq $before.account_locked_at
  Record ($state+' owner cannot self-unlock profile') 'Client JWT cannot rewrite server-owned account lifecycle, even though generic column UPDATE privilege exists' @{http=$r.status;rows=$(if($r.status -lt 300){Rows $r.content}else{0});authoritativeStatus=$after.account_status;unchanged=$unchanged} ($unchanged -and ($r.status -ge 400 -or (Rows $r.content) -eq 0))
  $r=Api Patch ('/rest/v1/profiles?id=eq.'+$a.id) $b.token '{"account_status":"active","account_locked_at":null}'
  $after=ReadAdmin $a.id;$unchanged=$after.account_status -eq $before.account_status -and $after.account_locked_at -eq $before.account_locked_at
  Record ($state+' foreign actor cannot unlock profile') 'Foreign valid actor cannot mutate synthetic target lifecycle' @{http=$r.status;unchanged=$unchanged} ($unchanged -and ($r.status -ge 400 -or (Rows $r.content) -eq 0))
 }
 $r=Api Get ('/rest/v1/profiles?select=id&id=eq.'+$b.id) $a.token $null @{'x-user-id'=$b.id;'x-user-role'='service_role';'x-role'='service_role'}
 Record 'caller-controlled authority headers' 'Forged role/user headers cannot reveal the other synthetic profile' @{http=$r.status;rows=$(if($r.status -eq 200){Rows $r.content}else{0})} ($r.status -eq 200 -and (Rows $r.content) -eq 0)
 $r=Api Get ('/rest/v1/profiles?select=id&or=(id.eq.'+$a.id+',id.eq.'+$b.id+')') $a.token
 $ids=@(($r.content|ConvertFrom-Json)|ForEach-Object {$_.id});Record 'broad caller filter remains RLS-scoped' 'A filter naming both synthetic identities returns only the verified caller' @{http=$r.status;rows=$ids.Count;foreignReturned=($ids -contains $b.id)} ($r.status -eq 200 -and $ids.Count -eq 1 -and $ids[0] -eq $a.id)
 $bad=$a.id;foreach($pair in @(@('a',[char]0x0430),@('e',[char]0x0435),@('c',[char]0x0441))){if($bad.Contains($pair[0])){$bad=$bad.Replace([string]$pair[0],[string]$pair[1]);break}}
 if($bad -eq $a.id){throw 'No eligible UUID homoglyph character in this fixture'}
 $r=Api Get ('/rest/v1/profiles?select=id&id=eq.'+[Uri]::EscapeDataString($bad)) $a.token
 Record 'Unicode homoglyph UUID input' 'Invalid UUID cannot be normalized into an authorized/foreign identifier or expose records' @{http=$r.status} ($r.status -ge 400)
}catch{$errors+=@{disposition='HARNESS OR SETUP ERROR';message=$_.Exception.Message;errorType=$_.Exception.GetType().Name}}
finally{
 foreach($a in $actors){$r=Api Get ('/auth/v1/admin/users/'+$a.id) $admin;if(($r.content|ConvertFrom-Json).app_metadata.build35_hostile_fixture -eq $run){$r=Api Delete ('/auth/v1/admin/users/'+$a.id) $admin;Record 'tag-verified synthetic cleanup' 'Delete only the run-tagged fixture identity' @{http=$r.status} ($r.status -lt 300)}else{$errors+=@{disposition='CLEANUP TAG MISMATCH; no delete'}}}
 @{capturedAt=[DateTime]::UtcNow.ToString('o');projectRef=$ref;records=$records;errors=$errors;limits='Profiles table lifecycle authority only; does not certify every RPC, account restoration capability, provider or resource';productionChanges=$false;providerCalls=0}|ConvertTo-Json -Depth 10|Out-File -Encoding utf8 C:/b35readback1030/profile-authority-staging-results.json
 $records|Select-Object probe,verdict;Remove-Variable admin,anon,keys,pw -ErrorAction SilentlyContinue
}
