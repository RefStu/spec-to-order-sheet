/**
 * 鍵の読み込み (`.local/emulator/emulator-keys.json`)。作るのは generate-keys.ts (`make keys`)。
 *
 * ⚠ **リクエストのたびに mtime を見て読み直す。** `make keys` と `make dev` の起動順を
 *   気にしなくてよくなる (鍵が後からできても再起動が要らない)。
 * ⚠ ここには **invoker SA の公開鍵しか無い**。秘密鍵は web の .dev.vars にだけある。
 */
import { createPublicKey, createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export interface EmulatorKeys {
  /** invoker SA。assertion の検証に使う (公開鍵だけ)。 */
  sa: { clientEmail: string; clientId: string; kid: string; publicKey: KeyObject };
  /** emulator 自身の署名鍵 (Google の署名鍵の代わり)。ID token と /jwks に使う。 */
  google: {
    kid: string;
    privateKey: KeyObject;
    publicKey: KeyObject;
    jwk: Record<string, unknown>;
  };
}

interface KeysFile {
  sa: { client_email: string; client_id: string; kid: string; jwk: Record<string, unknown> };
  google: { kid: string; private_key_pem: string; jwk: Record<string, unknown> };
}

function read(file: string): EmulatorKeys {
  let parsed: KeysFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as KeysFile;
  } catch (e) {
    throw new Error(
      `鍵を読めません (${file}): ${(e as Error).message}\n` +
        `   make keys で作られます (無いときだけ作られ、あるものは作り直されません)。`,
      { cause: e },
    );
  }
  if (!parsed.sa?.jwk || !parsed.google?.private_key_pem) {
    throw new Error(
      `鍵の形が違います (${file})。rm -r .local/emulator && make keys で作り直してください。`,
    );
  }
  const googlePrivateKey = createPrivateKey(parsed.google.private_key_pem);
  return {
    sa: {
      clientEmail: parsed.sa.client_email,
      clientId: parsed.sa.client_id,
      kid: parsed.sa.kid,
      publicKey: createPublicKey({ key: parsed.sa.jwk as never, format: "jwk" }),
    },
    google: {
      kid: parsed.google.kid,
      privateKey: googlePrivateKey,
      // 署名の検証は公開鍵で行う (秘密鍵から導く)。
      publicKey: createPublicKey(googlePrivateKey),
      jwk: parsed.google.jwk,
    },
  };
}

/** mtime が変わったときだけ読み直すローダを作る。 */
export function createKeyLoader(file: string): () => EmulatorKeys {
  let cached: { mtimeMs: number; keys: EmulatorKeys } | undefined;
  return () => {
    const mtimeMs = statSync(file).mtimeMs;
    if (!cached || cached.mtimeMs !== mtimeMs) cached = { mtimeMs, keys: read(file) };
    return cached.keys;
  };
}
