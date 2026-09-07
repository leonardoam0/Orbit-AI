const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function key(): Promise<CryptoKey> {
  const raw = Deno.env.get("ORBIT_ENCRYPTION_KEY");
  if (!raw) throw new Error("ORBIT_ENCRYPTION_KEY is not configured");
  const bytes = base64ToBytes(raw);
  if (bytes.length !== 32) throw new Error("ORBIT_ENCRYPTION_KEY must decode to 32 bytes");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), encoder.encode(secret)));
  const payload = new Uint8Array(iv.length + encrypted.length);
  payload.set(iv, 0);
  payload.set(encrypted, iv.length);
  return bytesToBase64(payload);
}

export async function decryptSecret(payload: string): Promise<string> {
  const bytes = base64ToBytes(payload);
  const iv = bytes.slice(0, 12);
  const encrypted = bytes.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await key(), encrypted);
  return decoder.decode(plain);
}
