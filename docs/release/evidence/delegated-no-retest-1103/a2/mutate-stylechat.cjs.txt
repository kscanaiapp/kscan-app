// One-guard-at-a-time mutation runner for audit/a2/stylechat-batch3.test.ts. Restores each file with git checkout.
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const D = 'supabase/functions/stylechat-generate/';
const muts = [
  ['S1 spoofable actor (x-user-id wins)', D + 'index.ts', "const userId = user.id;", "const userId = req.headers.get('x-user-id') ?? user.id;"],
  ['S2 session ownership filter removed', D + 'index.ts', "    .eq('id', sessionId)\n    .eq('user_id', userId)\n    .maybeSingle();", "    .eq('id', sessionId)\n    .maybeSingle();"],
  ['S3 message length guard removed', D + 'index.ts', "if (message.length > MAX_MESSAGE_CHARS) {", "if (false) {"],
  ['S4 sessionId UUID check removed', D + 'index.ts', "if (!UUID_V4ISH_RE.test(sessionId)) {", "if (false) {"],
  ['S5 burst denial ignored', D + 'index.ts', "if (!burstRow.allowed) {", "if (false) {"],
  ['S6 lifecycle gate removed', D + 'index.ts', "await assertAccountActive(userId);", "/* removed */"],
  ['S7 unsafe-output strip function disabled', D + 'promptHardening.ts', 'export function stripUnsafeModelOutput(text: string): string {\n  return text\n', 'export function stripUnsafeModelOutput(text: string): string {\n  return text;\n  return text\n'],
  ['S8 burst RPC error fails open', D + 'index.ts', "if (burstError) {", "if (false) {"],
  ['S9 provider error detail echoed', D + 'index.ts', "    // Return safe fallback — do not expose internal error details.\n    return json({\n      status: 'error',\n      message: {\n        sender: 'assistant',\n        content: buildStyleChatFallback(),", "    // Return safe fallback — do not expose internal error details.\n    return json({\n      status: 'error',\n      message: {\n        sender: 'assistant',\n        content: String((err as Error).message),"],
  ['S10 prompt data brackets not escaped', D + 'activeContext.ts', String.raw`.replace(/\[/g, '(')
      .replace(/\]/g, ')')`, ''],
  ['S11 bearer prefix check removed', D + 'index.ts', "if (!authHeader?.startsWith('Bearer ')) {", "if (false) {"],
];
const out = [];
for (const [name, file, find, rep] of muts) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) continue;
  let s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const n = s.split(find).length - 1;
  if (n !== 1) { out.push({ name, applied: false, matches: n }); continue; }
  fs.writeFileSync(file, s.replace(find, rep));
  const r = spawnSync('deno', ['test', '--no-check', '--allow-read', '--allow-env', '--allow-write=audit/a2/out', 'audit/a2/stylechat-batch3.test.ts'], { encoding: 'utf8', timeout: 240000 });
  const text = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '');
  const failed = [...new Set([...text.matchAll(/^(.*) \.\.\. FAILED/gm)].map((m) => m[1].replace(/ \(.*/, '')))];
  execSync('git checkout -- ' + file);
  out.push({ name, applied: true, detected: failed.length > 0, failing: failed });
}
const dirty = execSync('git status --short').toString().split('\n').filter((l) => l && !l.startsWith('??'));
console.log(JSON.stringify({ muts: out, dirtyTrackedFiles: dirty }, null, 1));
fs.writeFileSync('audit/a2/out/stylechat-batch3-mutations' + (process.env.ONLY ? '-partial' : '') + '.json', JSON.stringify({ muts: out }, null, 1));
