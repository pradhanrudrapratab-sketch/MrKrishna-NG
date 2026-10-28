import 'dotenv/config';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
function cleanNumber(value, name) {
  const number = required(name).replace(/\D/g, '');
  if (!/^\d{8,15}$/.test(number)) throw new Error(`${name} must be 8-15 digits including country code, without +`);
  return number;
}
export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  ownerNumber: cleanNumber(process.env.OWNER_NUMBER, 'OWNER_NUMBER'),
  whatsappNumber: cleanNumber(process.env.WHATSAPP_NUMBER, 'WHATSAPP_NUMBER'),
  apiKey: required('API_KEY'),
  totpSecret: required('ADMIN_TOTP_SECRET').replace(/\s/g, '').toUpperCase(),
  sessionExport: process.env.WHATSAPP_SESSION?.trim() || '',
};
if (config.apiKey.length < 24) throw new Error('API_KEY must be at least 24 characters long.');
if (!/^[A-Z2-7]+=*$/.test(config.totpSecret)) throw new Error('ADMIN_TOTP_SECRET must be a Base32 secret. Run npm run setup:totp.');
