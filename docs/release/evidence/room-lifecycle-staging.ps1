$ErrorActionPreference='Stop'
$base='https://yzqjvdfgefveprobvvyw.supabase.co';$ref='yzqjvdfgefveprobvvyw'
if($base -ne 'https://yzqjvdfgefveprobvvyw.supabase.co'){throw 'Staging only'}
$keys=supabase projects api-keys --project-ref $ref --output json|ConvertFrom-Json
$admin=($keys|Where-Object {$_.name -eq 'service_role'}).api_key;$anon=($keys|Where-Object {$_.name -eq 'anon'}).api_key
if(!$admin -or !$anon){throw 'Keys unavailable'}
$run=[guid]::NewGuid().ToString('N');$id=$null;$roomId=$null;$results=@()
function Api($method,$path,$token,$body=$null){$h=@{apikey=$anon;Authorization=('Bearer '+$token);Prefer='return=representation'};if($token -eq $admin){$h.apikey=$admin};try{$args=@{Method=$method;Uri=($base+$path);Headers=$h;ContentType='application/json';UseBasicParsing=$true;TimeoutSec=20};if($null -ne $body){$args.Body=$body};$r=Invoke-WebRequest @args;return @{status=[int]$r.StatusCode;body=$r.Content}}catch{if($_.Exception.Response){return @{status=[int]$_.Exception.Response.StatusCode;body=([IO.StreamReader]::new($_.Exception.Response.GetResponseStream())).ReadToEnd()}};throw}}
try{
 $email='build35-discovery-lifecycle-'+$run+'@example.invalid';$pw=[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N')
 $r=Api Post '/auth/v1/admin/users' $admin (@{email=$email;password=$pw;email_confirm=$true;app_metadata=@{build35_hostile_fixture=$run}}|ConvertTo-Json -Depth 5);if($r.status -ge 300){throw 'Fixture creation failed'};$id=($r.body|ConvertFrom-Json).id
 $r=Api Post '/auth/v1/token?grant_type=password' $anon (@{email=$email;password=$pw}|ConvertTo-Json);if($r.status -ge 300){throw 'Fixture login failed'};$token=($r.body|ConvertFrom-Json).access_token
 $roomId=[guid]::NewGuid().ToString();$r=Api Post '/rest/v1/dressing_rooms' $token (@{id=$roomId;user_id=$id;title=('Synthetic lifecycle '+$run)}|ConvertTo-Json);if($r.status -ge 300){throw 'Synthetic room baseline setup failed'}
 foreach($state in @('active','pending_deletion','locked')){
  $r=Api Patch ('/rest/v1/profiles?id=eq.'+$id) $admin (@{account_status=$state;account_locked_at=$(if($state -eq 'locked'){[DateTime]::UtcNow.ToString('o')}else{$null})}|ConvertTo-Json)
  if($r.status -ge 300 -or @($r.body|ConvertFrom-Json).Count -ne 1){throw 'Synthetic state setup failed'}
  $auth=Api Get '/auth/v1/user' $token
  $r=Api Get ('/rest/v1/dressing_rooms?select=id&id=eq.'+$roomId) $token
  $result=$r.body|ConvertFrom-Json
  $roomRows=0;if($null -ne $result){$roomRows=@($result).Count}
  $results+=@{probe=('verified actor with '+$state+' profile');environment='Staging synthetic tagged actor';authStatus=$auth.status;status=$r.status;resourceRows=$roomRows;runId=$run;expected=$(if($state -eq 'active'){'Baseline valid request'}else{'No private room data after authoritative account restriction'})}
 }
} catch {$results+=@{probe='fixture execution';status='INVALID HARNESS';errorType=$_.Exception.GetType().Name;message=$_.Exception.Message}}
finally{
 if($roomId -and $id){$verifyRoom=Api Get ('/rest/v1/dressing_rooms?select=user_id&id=eq.'+$roomId) $admin;if((($verifyRoom.body|ConvertFrom-Json)|Select-Object -First 1).user_id -eq $id){$r=Api Delete ('/rest/v1/dressing_rooms?id=eq.'+$roomId) $admin;$results+=@{probe='verified synthetic room cleanup';status=$r.status;runId=$run}}}
 if($id){$r=Api Get ('/auth/v1/admin/users/'+$id) $admin;if(($r.body|ConvertFrom-Json).app_metadata.build35_hostile_fixture -eq $run){$r=Api Delete ('/auth/v1/admin/users/'+$id) $admin;$results+=@{probe='tag-verified synthetic cleanup';status=$r.status;runId=$run}}else{$results+=@{probe='cleanup';status='TAG MISMATCH; no delete'}}}
 $results|ConvertTo-Json -Depth 8|Out-File -Encoding utf8 C:/b35evidence1029/docs/release/evidence/continuation-room-lifecycle-staging.json
 $results|Select-Object probe,status,authStatus,resourceRows
 Remove-Variable admin,anon,keys,token,pw -ErrorAction SilentlyContinue
}
