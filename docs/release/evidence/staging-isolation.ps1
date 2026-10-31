$ErrorActionPreference='Stop'
$projectRef='yzqjvdfgefveprobvvyw'
$base='https://yzqjvdfgefveprobvvyw.supabase.co'
if($projectRef -ne 'yzqjvdfgefveprobvvyw' -or $base -match 'wyyuqfdxucjksghsmhry'){throw 'Staging identity mismatch'}
$keyRows=supabase projects api-keys --project-ref $projectRef --output json | ConvertFrom-Json
$adminKey=($keyRows | Where-Object {$_.name -eq 'service_role'}).api_key
$anonKey=($keyRows | Where-Object {$_.name -eq 'anon'}).api_key
if(!$adminKey -or !$anonKey){throw 'Staging keys unavailable'}
$runId=[guid]::NewGuid().ToString('N')
$actors=@();$results=@();$objects=@();$roomId=$null
function Call-Api($method,$path,$token,$body=$null,$contentType='application/json') {
 $headers=@{apikey=$anonKey;Authorization=('Bearer '+$token);Prefer='return=representation'}
 if($token -eq $adminKey){$headers.apikey=$adminKey}
 $args=@{Method=$method;Uri=($base+$path);Headers=$headers;UseBasicParsing=$true;TimeoutSec=20;ContentType=$contentType}
 if($null -ne $body){$args.Body=$body}
 try{$r=Invoke-WebRequest @args;return [pscustomobject]@{status=[int]$r.StatusCode;content=$r.Content}}
 catch{if($_.Exception.Response){$r=$_.Exception.Response;return [pscustomobject]@{status=[int]$r.StatusCode;content=([IO.StreamReader]::new($r.GetResponseStream())).ReadToEnd()}};throw}
}
function Row-Count($json){$parsed=$json|ConvertFrom-Json;if($null -eq $parsed){return 0};return @($parsed).Count}
function Record($probe,$expected,$actual,$ok){$script:results += [pscustomobject]@{probe=$probe;environment='Staging, tagged ephemeral synthetic actors only';expected=$expected;actual=$actual;verdict=$(if($ok){'PASS'}else{'FAIL'});runId=$runId}}
try{
 foreach($label in @('A','B')){
  $email="build35-hostile-$runId-$label@example.invalid"
  $password=([guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N'))
  $body=@{email=$email;password=$password;email_confirm=$true;app_metadata=@{build35_hostile_fixture=$runId}}|ConvertTo-Json -Depth 5
  $r=Call-Api Post '/auth/v1/admin/users' $adminKey $body
  if($r.status -ge 300){throw ('Synthetic actor creation failed: HTTP '+$r.status)}
  $user=$r.content|ConvertFrom-Json
  $actor=[pscustomobject]@{label=$label;id=$user.id;token=$null};$actors+= $actor
  $r=Call-Api Post '/auth/v1/token?grant_type=password' $anonKey (@{email=$email;password=$password}|ConvertTo-Json)
  if($r.status -ge 300){throw ('Synthetic actor sign-in failed: HTTP '+$r.status)}
  $actor.token=($r.content|ConvertFrom-Json).access_token
 }
 $a=$actors[0];$b=$actors[1]
 foreach($pair in @(@($a,$a),@($b,$b),@($a,$b),@($b,$a))){
  $r=Call-Api Get ("/rest/v1/profiles?select=id,account_status&id=eq."+$pair[1].id) $pair[0].token
  $own=$pair[0].id -eq $pair[1].id;$count=Row-Count $r.content
  Record ('profile '+$pair[0].label+' -> '+$pair[1].label) $(if($own){'Exactly own synthetic row'}else{'No foreign rows'}) ('HTTP '+$r.status+' rows='+$count) ($r.status -eq 200 -and $count -eq $(if($own){1}else{0}))
 }
 $r=Call-Api Patch ("/rest/v1/profiles?select=id&id=eq."+$b.id) $a.token '{"account_status":"active"}'
 $changed=(Row-Count $r.content)
 Record 'User A cannot update User B profile' 'No changed foreign row' ('HTTP '+$r.status+' rows='+$changed) (($r.status -ge 400)-or $changed -eq 0)
 $roomId=[guid]::NewGuid().ToString()
 $r=Call-Api Post '/rest/v1/dressing_rooms' $a.token (@{id=$roomId;user_id=$a.id;title=('Synthetic audit '+$runId)}|ConvertTo-Json)
 if($r.status -lt 300){
  $r=Call-Api Get ("/rest/v1/dressing_rooms?select=id&id=eq."+$roomId) $a.token
  Record 'User A own room baseline' 'One owned synthetic room' ('HTTP '+$r.status+' rows='+(Row-Count $r.content)) ($r.status -eq 200 -and (Row-Count $r.content) -eq 1)
  $r=Call-Api Get ("/rest/v1/dressing_rooms?select=id&id=eq."+$roomId) $b.token
  Record 'User B guessed room ID without membership' 'No room rows' ('HTTP '+$r.status+' rows='+(Row-Count $r.content)) ($r.status -eq 200 -and (Row-Count $r.content) -eq 0)
  $r=Call-Api Post '/rest/v1/rpc/resolve_dressing_room_collaboration_access' $b.token (@{p_room_id=$roomId}|ConvertTo-Json)
  Record 'User B guessed room RPC without membership' 'Authoritative access decision denies' ('HTTP '+$r.status+' ok='+($r.content|ConvertFrom-Json).ok) (($r.content|ConvertFrom-Json).ok -eq $false)
  $r=Call-Api Post '/rest/v1/rpc/create_or_get_room_share' $a.token (@{p_room_id=$roomId}|ConvertTo-Json)
  if($r.status -ge 300){throw ('Synthetic share creation failed: HTTP '+$r.status)}
  $shareToken=$r.content|ConvertFrom-Json
  $r=Call-Api Post '/rest/v1/rpc/join_room_via_share_token' $b.token (@{p_share_token=$shareToken}|ConvertTo-Json)
  if($r.status -ge 300){throw ('Synthetic member join failed: HTTP '+$r.status)}
  $r=Call-Api Post '/rest/v1/rpc/resolve_dressing_room_collaboration_access' $b.token (@{p_room_id=$roomId}|ConvertTo-Json)
  $memberBaseline=$r.status -eq 200 -and ($r.content|ConvertFrom-Json).ok -eq $true
  Record 'User B active membership RPC baseline' 'Actual share join authorizes collaboration' ('HTTP '+$r.status+' ok='+($r.content|ConvertFrom-Json).ok) $memberBaseline
  $r=Call-Api Post '/rest/v1/rpc/create_dressing_room_message' $a.token (@{p_room_id=$roomId;p_body='Synthetic campaign fixture';p_client_message_id=[guid]::NewGuid().ToString();p_parent_message_id=$null}|ConvertTo-Json)
  if($r.status -ge 300){throw ('Synthetic message creation failed: HTTP '+$r.status)}
  $r=Call-Api Post '/rest/v1/rpc/list_dressing_room_messages' $b.token (@{p_room_id=$roomId;p_limit=10;p_cursor_created_at=$null;p_cursor_id=$null;p_direction='older'}|ConvertTo-Json)
  $messageBaseline=$r.status -eq 200 -and ($r.content|ConvertFrom-Json).ok -eq $true -and @((($r.content|ConvertFrom-Json).messages)).Count -eq 1
  Record 'Active member reads synthetic message via real RPC' 'One synthetic message' ('HTTP '+$r.status+' count='+@((($r.content|ConvertFrom-Json).messages)).Count) $messageBaseline
  $r=Call-Api Patch ("/rest/v1/dressing_room_participants?dressing_room_id=eq."+$roomId+'&user_id=eq.'+$b.id) $adminKey (@{left_at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json)
  if($r.status -ge 300){throw ('Synthetic membership removal failed: HTTP '+$r.status)}
  $r=Call-Api Post '/rest/v1/rpc/resolve_dressing_room_collaboration_access' $b.token (@{p_room_id=$roomId}|ConvertTo-Json)
  Record 'Removed member reuses valid JWT against collaboration RPC' 'Authoritative decision denies after real membership removal' ('HTTP '+$r.status+' ok='+($r.content|ConvertFrom-Json).ok) ($memberBaseline -and ($r.content|ConvertFrom-Json).ok -eq $false)
  $r=Call-Api Post '/rest/v1/rpc/list_dressing_room_messages' $b.token (@{p_room_id=$roomId;p_limit=10;p_cursor_created_at=$null;p_cursor_id=$null;p_direction='older'}|ConvertTo-Json)
  Record 'Removed member cannot read messages via real RPC' 'Access denied without message content' ('HTTP '+$r.status+' ok='+($r.content|ConvertFrom-Json).ok) ($messageBaseline -and (($r.status -ge 400)-or (($r.content|ConvertFrom-Json).ok -eq $false)))
 }
 $png=[Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfy8AAAAASUVORK5CYII=')
 $path=$a.id+'/saved-scans/'+$runId+'.png'
 $r=Call-Api Post ('/storage/v1/object/style-library-images/'+$path) $a.token $png 'image/png'
 Record 'User A synthetic private upload baseline' 'Owned fixture upload succeeds' ('HTTP '+$r.status) ($r.status -lt 300)
 if($r.status -lt 300){
  $objects+= $path
  $r=Call-Api Get ('/storage/v1/object/authenticated/style-library-images/'+$path) $b.token
  Record 'User B cannot read User A storage path' 'Explicit denial or hidden object' ('HTTP '+$r.status) ($r.status -ge 400)
  $r=Call-Api Post ('/storage/v1/object/sign/style-library-images/'+$path) $b.token '{"expiresIn":30}'
  Record 'User B cannot sign User A storage path' 'Explicit denial' ('HTTP '+$r.status) ($r.status -ge 400)
  $r=Call-Api Post ('/storage/v1/object/sign/style-library-images/'+$path) $a.token '{"expiresIn":2}'
  if($r.status -lt 300){
   $signed=($r.content|ConvertFrom-Json).signedURL
   $uri=$base+'/storage/v1'+$signed
   try{$response=Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 15;$before=[int]$response.StatusCode}catch{$before=[int]$_.Exception.Response.StatusCode}
   Start-Sleep -Seconds 3
   try{$response=Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 15;$after=[int]$response.StatusCode}catch{$after=[int]$_.Exception.Response.StatusCode}
   Record 'Expired signed URL replay' 'Initially readable, then explicit denial after expiry' ('before='+$before+' after='+$after) ($before -eq 200 -and $after -ge 400)
  }
 }
 $foreign=$b.id+'/saved-scans/'+$runId+'.png'
 $r=Call-Api Post ('/storage/v1/object/style-library-images/'+$foreign) $a.token $png 'image/png'
 Record 'User A cannot upload into User B storage prefix' 'Explicit denial' ('HTTP '+$r.status) ($r.status -ge 400)
 if($r.status -lt 300){$objects+=$foreign}
} catch {
 $results += [pscustomobject]@{probe='fixture/harness execution';verdict='NOT TESTED';reason=$_.Exception.Message;runId=$runId}
} finally {
 if($objects.Count){$null=Call-Api Delete '/storage/v1/object/style-library-images' $adminKey (@{prefixes=$objects}|ConvertTo-Json)}
 if($roomId){$null=Call-Api Delete ("/rest/v1/dressing_rooms?id=eq."+$roomId) $adminKey}
 foreach($actor in $actors){
  $r=Call-Api Get ('/auth/v1/admin/users/'+$actor.id) $adminKey
  $verify=$r.content|ConvertFrom-Json
  if($verify.app_metadata.build35_hostile_fixture -eq $runId){$r=Call-Api Delete ('/auth/v1/admin/users/'+$actor.id) $adminKey;Record ('cleanup synthetic actor '+$actor.label) 'Only campaign-tagged actor deleted' ('HTTP '+$r.status) ($r.status -lt 300)}
  else{Record ('cleanup synthetic actor '+$actor.label) 'Campaign tag must match before deletion' 'Tag check failed; deletion not attempted' $false}
 }
 $results|ConvertTo-Json -Depth 8|Out-File -Encoding utf8 C:/b35evidence1029/docs/release/evidence/staging-isolation-results.json
 $results|Select-Object probe,verdict,actual
 Remove-Variable adminKey,anonKey,keyRows,actors -ErrorAction SilentlyContinue
}
