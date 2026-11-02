import fs from 'node:fs';
import path from 'node:path';

export async function controlService(dataDir, root, expectedPid) {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'service-runtime.json'), 'utf8')); }
  catch { return null; }
  if (saved.root !== root || (expectedPid && saved.childPid !== expectedPid)) return null;
  const response = await fetch(`http://127.0.0.1:${saved.controlPort}/stop`, {
    method: 'POST', headers: { Authorization: `Bearer ${saved.key}` }, signal: AbortSignal.timeout(10000)
  }).catch(() => null);
  if (!response) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '服务控制失败');
  if (result.pid !== saved.childPid || result.root !== root) throw new Error('服务身份不匹配，未停止进程');
  return result;
}
