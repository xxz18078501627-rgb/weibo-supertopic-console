import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokenFile = path.join(root, 'data', 'access-token');
if (!fs.existsSync(tokenFile)) {
  console.error('访问口令尚未生成。请先运行一次 npm start。');
  process.exit(1);
}
console.log(fs.readFileSync(tokenFile, 'utf8').trim());
