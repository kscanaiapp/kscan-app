const root=Deno.args[0].replaceAll('\\','/');
const {requestElevenLabsSpeech}=await import('file:///'+root+'/supabase/functions/stylist-speech/elevenLabsClient.ts');
Deno.test('empty successful ElevenLabs HTTP body fails without speech success or retry',async()=>{
 const values=new Map([['ELEVENLABS_API_KEY','synthetic-test-only'],['ELEVENLABS_STYLIST_TEST_FEMININE_VOICE_ID','A'.repeat(20)],['ELEVENLABS_MODEL_ID','eleven_flash_v2_5'],['ELEVENLABS_OUTPUT_FORMAT','mp3_44100_128']]);let calls=0;
 let rejected=false;try{await requestElevenLabsSpeech({text:'Synthetic harmless sentence',voiceProfile:'feminine',voiceSecretName:'ELEVENLABS_STYLIST_TEST_FEMININE_VOICE_ID',env:{get:(k:string)=>values.get(k)},diagnosticsSink:()=>{},fetchImpl:async()=>{calls++;return new Response('',{status:200});}});}catch(e:unknown){if(!e||typeof e!=='object'||!('code' in e)||e.code!=='PROVIDER_RESPONSE_INVALID')throw e;rejected=true;}if(!rejected||calls!==1)throw Error('Expected invalid provider body rejection and exactly one dispatch');
});
