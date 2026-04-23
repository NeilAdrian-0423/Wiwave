import selfsigned from 'selfsigned';
import fs from 'node:fs';

const attrs = [{ name: 'commonName', value: 'voicechat.local' }];
const pems = selfsigned.generate(attrs, {
  days: 3650,
  keySize: 2048,
  algorithm: 'sha256',
});

fs.writeFileSync('cert.pem', pems.cert);
fs.writeFileSync('key.pem', pems.private);
console.log('Wrote cert.pem and key.pem');
