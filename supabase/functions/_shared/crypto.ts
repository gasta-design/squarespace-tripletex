// AES-256-GCM-kryptering av API-nøkler. Nøkkelen kommer fra Edge Function-secret ENCRYPTION_KEY.
const enc = new TextEncoder();
const dec = new TextDecoder();
let keyPromise: Promise<CryptoKey> | null = null;

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    const secret = Deno.env.get("ENCRYPTION_KEY");
    if (!secret || secret.length < 32) {
      throw new Error("ENCRYPTION_KEY mangler eller er kortere enn 32 tegn");
    }
    keyPromise = crypto.subtle
      .digest("SHA-256", enc.encode(secret))
      .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }
  return keyPromise;
}

export async function encrypt(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await getKey(), enc.encode(plain));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

export async function decrypt(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  const [v, iv, ct] = value.split(":");
  if (v !== "v1" || !iv || !ct) throw new Error("Ugyldig kryptert verdi");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await getKey(), unb64(ct));
  return dec.decode(pt);
}
