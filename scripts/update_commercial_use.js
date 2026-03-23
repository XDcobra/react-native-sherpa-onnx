const fs = require('fs');
const path = require('path');

const commercialMapping = {
  'agpl-3.0': 'conditional',
  'apache-2.0': 'yes',
  'bsd-3-clause': 'yes',
  'cc-by': 'yes',
  'cc-by-3.0': 'yes',
  'cc-by-4.0': 'yes',
  'cc-by-nc-4.0': 'no',
  'cc-by-nc-nd-4.0': 'no',
  'cc-by-nc-sa-4.0': 'no',
  'cc-by-sa': 'conditional',
  'cc-by-sa-3.0-es': 'conditional',
  'cc-by-sa-4.0': 'conditional',
  'cc0': 'yes',
  'gpl-2.0': 'conditional',
  'mit': 'yes',
  'ngc-terms-of-use': 'restricted',
  'no-license': 'no',
  'nvidia-open-model-license': 'yes',
  'proprietary-restricted': 'no',
  'public-domain': 'yes',
  'research-only': 'no',
  'unlicense': 'yes',
};

const files = [
  'android/src/main/assets/model_licenses/asr-models-license-status.csv',
  'android/src/main/assets/model_licenses/qnn-asr-models-license-status.csv',
  'android/src/main/assets/model_licenses/tts-models-license-status.csv',
];

files.forEach((fileName) => {
  const filePath = path.resolve(__dirname, '..', fileName);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const newLines = [];

  // Keep header
  newLines.push(lines[0]);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      if (i < lines.length - 1 || line === '') newLines.push(line);
      continue;
    }

    const columns = line.split(',');
    if (columns.length > 2) {
      const licenseType = columns[1].trim();
      const currentCommercialUse = columns[2].trim();

      if (currentCommercialUse === 'unknown') {
        const mappedValue = commercialMapping[licenseType];
        if (mappedValue) {
          columns[2] = mappedValue;
        }
      }
    }
    newLines.push(columns.join(','));
  }

  fs.writeFileSync(filePath, newLines.join('\n'), 'utf-8');
  console.log(`Updated commercial_use in ${fileName}`);
});
