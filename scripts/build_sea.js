import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(path.join(__dirname, '..'));

console.log('--- STARTING NATIVE NODE SEA BUILD ---');

try {
  // 1. Ensure dist/ exists
  if (!fs.existsSync(path.join(rootDir, 'dist'))) {
    fs.mkdirSync(path.join(rootDir, 'dist'), { recursive: true });
  }

  // 2. Esbuild bundling
  console.log('1. Bundling with esbuild...');
  execSync('npx esbuild server.js --bundle --platform=node --format=cjs --outfile=dist/server.cjs', { cwd: rootDir, stdio: 'inherit' });

  // 3. Create sea-config.json
  console.log('2. Creating sea-config.json...');
  const seaConfig = {
    main: 'dist/server.cjs',
    output: 'dist/sea-prep.blob',
    disableSentinel: true
  };
  fs.writeFileSync(path.join(rootDir, 'dist', 'sea-config.json'), JSON.stringify(seaConfig, null, 2), 'utf8');

  // 4. Generate preparation blob
  console.log('3. Generating prep blob...');
  execSync('node --experimental-sea-config dist/sea-config.json', { cwd: rootDir, stdio: 'inherit' });

  // 5. Copy node.exe to localdrop.exe
  console.log('4. Copying node.exe binary...');
  const nodePath = process.execPath;
  fs.copyFileSync(nodePath, path.join(rootDir, 'localdrop.exe'));

  // 6. Inject the blob into localdrop.exe using postject
  console.log('5. Injecting blob using postject...');
  execSync('npx postject localdrop.exe NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_f1a528c2c8f165179161d5c169b1739b', { cwd: rootDir, stdio: 'inherit' });

  console.log('🎉 Successfully created native localdrop.exe single executable!');
} catch (err) {
  console.error('SEA Build failed:', err);
  process.exit(1);
}
