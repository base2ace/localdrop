import fs from 'fs';
import * as ResEdit from 'resedit';

const exePath = 'localdrop.exe';

try {
  const exeBuffer = fs.readFileSync(exePath);
  const pe = ResEdit.NtExecutable.from(exeBuffer);
  const res = ResEdit.NtExecutableResource.from(pe);

  console.log('--- RESOURCE ENTRIES KEYS ---');
  res.entries.forEach((entry) => {
    console.log('Entry properties:', Object.keys(entry));
    console.log(`Type: ${entry.type}, ID: ${entry.id}, Lang: ${entry.language || entry.lang}`);
  });
} catch (err) {
  console.error('Inspection failed:', err);
}
