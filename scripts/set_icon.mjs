import fs from 'fs';
import * as ResEdit from 'resedit';

const exePath = 'localdrop.exe';
const iconPath = 'public/logo.ico';

try {
  if (!fs.existsSync(exePath)) {
    throw new Error(`Executable file "${exePath}" not found.`);
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Icon file "${iconPath}" not found.`);
  }

  console.log('Loading executable...');
  const exeBuffer = fs.readFileSync(exePath);
  const pe = ResEdit.NtExecutable.from(exeBuffer);
  const res = ResEdit.NtExecutableResource.from(pe);

  console.log('Loading icon...');
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));

  // Clear all original RT_ICON (3) and RT_GROUP_ICON (14) resources to remove Node.js icons completely
  console.log('Clearing existing icon resources...');
  res.entries = res.entries.filter(
    (entry) => entry.type !== 3 && entry.type !== 14
  );

  console.log('Replacing icon resource...');
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    1, // ID of resource group
    1033, // Lang ID (English US)
    iconFile.icons.map((item) => item.data)
  );

  console.log('Writing resources to PE executable...');
  res.outputResource(pe);
  const newExeBuffer = pe.generate();
  fs.writeFileSync(exePath, Buffer.from(newExeBuffer));
  console.log('Successfully set custom icon on localdrop.exe!');
} catch (err) {
  console.error('Failed to set icon on executable:', err);
  process.exit(1);
}
