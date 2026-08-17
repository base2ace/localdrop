import fs from 'fs';

const src = 'C:\\Users\\LENOVO\\.gemini\\antigravity-ide\\brain\\db6e0d25-82a9-492c-a614-697bc2bdaa66\\secure_vector_icon_1786984457765.jpg';
const destLogo = 'public/logo.png';
const destFav = 'public/favicon.png';

try {
  fs.copyFileSync(src, destLogo);
  fs.copyFileSync(src, destFav);
  console.log('Successfully copied secure transfer logo to public folder!');
} catch (err) {
  console.error('Failed to copy file:', err);
  process.exit(1);
}
