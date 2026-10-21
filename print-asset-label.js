const sqlite3 = require('./sqlite-compat.js').verbose();
const { spawn } = require('child_process');

const dbPath = process.argv[3];

const printerName = process.argv[4];
const labelBaseUrl = process.argv[5];
if (!dbPath || !printerName || !labelBaseUrl || /[\^~\x00-\x20]/.test(labelBaseUrl)) {
  console.error('Configure the printer queue and QR label base URL in Quartermaster settings.');
  process.exit(1);
}
try {
  const url = new URL(labelBaseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
} catch { console.error('Label base URL must be an HTTP(S) origin, without credentials, path or query.'); process.exit(1); }
const assetId = Number(process.argv[2]);

if (!Number.isInteger(assetId) || assetId < 1) {
  console.error('Usage: node print-asset-label.js <asset-id>');
  process.exit(1);
}

function safeZpl(value, fallback = 'Not recorded') {
  const text = String(value ?? '').trim();

  if (!text) {
    return fallback;
  }

  return text
    .replace(/[\^~]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 100);
}

function buildQrPayload(asset) {
  return (
    new URL(labelBaseUrl).origin +
    '/plugins/signalk-quartermaster/asset/' +
    encodeURIComponent(asset.qr_code)
  );
}

function buildLabel(asset) {
  const qrPayload = buildQrPayload(asset);

  const equipmentDetails = [
    safeZpl(asset.manufacturer, ''),
    safeZpl(asset.model, '')
  ]
    .filter(Boolean)
    .join(' - ') || 'Manufacturer and model not recorded';

  return [
    '^XA',
    '^CI28',
    '^PW900',
    '^LL1500',
    '^LH0,0',
    '^MNY',
    

    '^FO40,40^GB820,1420,4^FS',

    '^FO70,80^A0N,58,58^FB760,1,0,C^FDQUARTERMASTER^FS',
    '^FO70,155^GB760,3,3^FS',

    `^FO230,205^BQN,2,8^FDLA,${qrPayload}^FS`,

    `^FO70,645^A0N,42,42^FB760,1,0,C^FD${safeZpl(asset.qr_code)}^FS`,

    '^FO70,720^GB760,3,3^FS',

    `^FO80,765^A0N,50,50^FB740,2,12,C^FD${safeZpl(asset.name)}^FS`,

    '^FO80,915^A0N,28,28^FDManufacturer / Model^FS',
    `^FO80,955^A0N,34,34^FB740,2,8,L^FD${safeZpl(equipmentDetails)}^FS`,

    '^FO80,1060^A0N,28,28^FDVessel^FS',
    `^FO80,1100^A0N,34,34^FB740,1,0,L^FD${safeZpl(asset.vessel_name)}^FS`,

    '^FO80,1170^A0N,28,28^FDLocation^FS',
    `^FO80,1210^A0N,34,34^FB740,2,8,L^FD${safeZpl(asset.location)}^FS`,

    '^FO70,1330^GB760,3,3^FS',
    `^FO80,1360^A0N,26,26^FDAsset ID: ${safeZpl(asset.id)}^FS`,
    '^FO80,1400^A0N,24,24^FDQuartermaster Asset Management^FS',

    '^PQ1,0,1,N',
    '^XZ'
  ].join('\n');
}

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);

const sql = `
  SELECT
    a.id,
    a.name,
    a.manufacturer,
    a.model,
    a.location,
    a.qr_code,
    v.name AS vessel_name
  FROM assets a
  JOIN vessels v
    ON a.vessel_id = v.id
  WHERE a.id = ?
`;

db.get(sql, [assetId], (dbError, asset) => {
  db.close();

  if (dbError) {
    console.error('Database error:', dbError.message);
    process.exitCode = 1;
    return;
  }

  if (!asset) {
    console.error(`Asset not found: ${assetId}`);
    process.exitCode = 1;
    return;
  }

  const zpl = buildLabel(asset);

  const printJob = spawn(
    'lp',
    ['-d', printerName, '-o', 'raw'],
    {
      stdio: ['pipe', 'inherit', 'inherit']
    }
  );

  printJob.on('error', (printError) => {
    console.error('Unable to start print job:', printError.message);
    process.exitCode = 1;
  });

  printJob.on('close', (code) => {
    if (code === 0) {
      console.log(
        `Label sent to ${printerName}: ` +
        `${asset.name} (${asset.qr_code})`
      );
    } else {
      console.error(`Print command exited with code ${code}`);
      process.exitCode = 1;
    }
  });

  printJob.stdin.on('error', () => { process.exitCode = 1; });
  printJob.stdin.end(zpl);
});
