import crypto from 'node:crypto';
// Convert raw random bytes to RFC 4648 Base32 without external tools.
const bytes = crypto.randomBytes(20);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let bits = 0, value = 0, base32 = '';
for (const byte of bytes) {
  value = (value << 8) | byte;
  bits += 8;
  while (bits >= 5) { base32 += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
}
if (bits > 0) base32 += alphabet[(value << (5 - bits)) & 31];
console.log('\nADMIN_TOTP_SECRET=' + base32);
console.log('\nAdd this value to your .env / Render environment variables.');
console.log('In your authenticator app, create a TOTP entry using this secret (6 digits, 30-second period).');
console.log('Keep this secret private. This script does not save it to a file.\n');
