import fs from 'fs';

const logoPng = 'public/logo_256.png';
const logoIco = 'public/logo.ico';

try {
  const pngBuffer = fs.readFileSync(logoPng);

  const icoBuffer = Buffer.alloc(22);

  // ICO Header
  icoBuffer.writeUInt16LE(0, 0); // Reserved (0)
  icoBuffer.writeUInt16LE(1, 2); // Image type (1 = ICO)
  icoBuffer.writeUInt16LE(1, 4); // Number of images (1)

  // Directory Entry
  icoBuffer.writeUInt8(0, 6); // Width (0 means 256)
  icoBuffer.writeUInt8(0, 7); // Height (0 means 256)
  icoBuffer.writeUInt8(0, 8); // Color palette size (0 = no palette)
  icoBuffer.writeUInt8(0, 9); // Reserved (0)
  icoBuffer.writeUInt16LE(1, 10); // Color planes (1)
  icoBuffer.writeUInt16LE(32, 12); // Bits per pixel (32)
  icoBuffer.writeUInt32LE(pngBuffer.length, 14); // Size of PNG data
  icoBuffer.writeUInt32LE(22, 18); // Offset of PNG data from header start

  const finalBuffer = Buffer.concat([icoBuffer, pngBuffer]);
  fs.writeFileSync(logoIco, finalBuffer);
  console.log('Successfully generated logo.ico!');
} catch (err) {
  console.error('Failed to generate ico file:', err);
  process.exit(1);
}
