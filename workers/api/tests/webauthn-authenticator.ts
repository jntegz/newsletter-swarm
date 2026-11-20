// A software WebAuthn authenticator for tests: real ES256 keys from WebCrypto, real CBOR
// attestation objects ("none" attestation) and real assertions, so the server's verification
// (signature, challenge, origin, RP ID, counter) runs exactly as it does for a browser.
import { base64UrlDecode, base64UrlEncode } from '@swarm/tokens';

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

function head(major: number, value: number): number[] {
  if (value < 24) return [(major << 5) | value];
  if (value < 0x100) return [(major << 5) | 24, value];
  if (value < 0x10000) return [(major << 5) | 25, value >> 8, value & 0xff];
  return [
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ];
}

function cbor(value: Cbor): Uint8Array {
  const out: number[] = [];
  const write = (v: Cbor) => {
    if (typeof v === 'number') {
      out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
    } else if (typeof v === 'string') {
      const bytes = new TextEncoder().encode(v);
      out.push(...head(3, bytes.length), ...bytes);
    } else if (v instanceof Uint8Array) {
      out.push(...head(2, v.length), ...v);
    } else if (Array.isArray(v)) {
      out.push(...head(4, v.length));
      v.forEach(write);
    } else {
      out.push(...head(5, v.size));
      for (const [key, item] of v) {
        write(key);
        write(item);
      }
    }
  };
  write(value);
  return new Uint8Array(out);
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const sha256 = async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', data));

const uint32 = (n: number) =>
  new Uint8Array([(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

/** WebCrypto returns r||s; WebAuthn wants an ASN.1 DER SEQUENCE of two INTEGERs. */
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let body = bytes.slice(i);
    if ((body[0] as number) & 0x80) body = concat(new Uint8Array([0]), body);
    return concat(new Uint8Array([0x02, body.length]), body);
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

interface PublicKeyOptions {
  challenge: string;
  rp?: { id?: string };
  rpId?: string;
}

export class SoftAuthenticator {
  credentialId = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;
  private keys: CryptoKeyPair | null = null;

  constructor(
    private readonly origin = 'http://localhost:5273',
    private readonly rpId = 'localhost',
  ) {}

  get id(): string {
    return base64UrlEncode(this.credentialId);
  }

  private async clientData(type: string, challenge: string, origin: string) {
    return new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  }

  /** navigator.credentials.create() for the given options. */
  async register(options: PublicKeyOptions, overrides: { origin?: string } = {}) {
    this.keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, base64UrlDecode(jwk.x as string)],
        [-3, base64UrlDecode(jwk.y as string)],
      ]),
    );
    const rpIdHash = await sha256(new TextEncoder().encode(options.rp?.id ?? this.rpId));
    const authData = concat(
      rpIdHash,
      new Uint8Array([0x45]), // user present, user verified, attested credential data
      uint32(this.counter),
      new Uint8Array(16), // AAGUID
      new Uint8Array([0, this.credentialId.length]),
      this.credentialId,
      cose,
    );
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    const clientDataJSON = await this.clientData(
      'webauthn.create',
      options.challenge,
      overrides.origin ?? this.origin,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: base64UrlEncode(clientDataJSON),
        attestationObject: base64UrlEncode(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** navigator.credentials.get(). `counter` overrides the next signature counter (clone tests). */
  async assert(options: PublicKeyOptions, overrides: { origin?: string; counter?: number } = {}) {
    if (!this.keys) throw new Error('register first');
    this.counter = overrides.counter ?? this.counter + 1;
    const rpIdHash = await sha256(new TextEncoder().encode(options.rpId ?? this.rpId));
    const authData = concat(rpIdHash, new Uint8Array([0x05]), uint32(this.counter));
    const clientDataJSON = await this.clientData(
      'webauthn.get',
      options.challenge,
      overrides.origin ?? this.origin,
    );
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: base64UrlEncode(clientDataJSON),
        authenticatorData: base64UrlEncode(authData),
        signature: base64UrlEncode(derSignature(raw)),
      },
      clientExtensionResults: {},
    };
  }
}
