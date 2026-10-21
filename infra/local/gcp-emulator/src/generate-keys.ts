/**
 * `make keys` — gcp-emulator が受け付けるダミー SA 鍵を作る。
 *
 * ⚠ **GCP には一切触れない。** ここで作るのは Node が生成する RSA 鍵だけ。
 * ⚠ **あるものは作り直さない。** apps/web の getIdToken() は audience ごとに ID token を
 *   最長 1 時間キャッシュするので、鍵を差し替えると 401 が出続ける。
 *   作り直したいときは `rm -r .local/emulator && make keys` し、.dev.vars の
 *   AI_INVOKER_SA_KEY を貼り直してから `make dev` を入れ直す。
 *
 * 鍵は 2 組作る。
 *   sa     … invoker SA の鍵。**秘密鍵は web (.dev.vars) にだけ渡す。**
 *   google … emulator が ID token を署名する鍵 (Google の署名鍵の代わり)。/jwks が出すのもこちら。
 * emulator に渡すファイルには sa の**公開鍵しか入れない**。これで Cloud Run IAM の
 * 「発行者だけが秘密鍵を持つ」形がローカルでもそのまま再現できる。
 *
 * 標準出力には .dev.vars に貼る 1 行 (`AI_INVOKER_SA_KEY='…'`) だけを出す。
 * ⚠ 値は単一引用符で囲む。wrangler の dotenv は二重引用符の中の `\"` を戻さないので、
 *   JSON を二重引用符で書くと Worker の JSON.parse が落ちる。
 */
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** web の .dev.vars に貼る SA 鍵 (秘密鍵を含む)。 */
export const SA_KEY_REL = ".local/emulator/sa-key.json";
/** gcp-emulator が読む鍵 (sa は公開鍵だけ)。 */
export const EMULATOR_KEYS_REL = ".local/emulator/emulator-keys.json";

const PROJECT = "spec-to-order-sheet";

interface KeyPair {
  privatePem: string;
  publicPem: string;
}

/** 実物の SA 鍵と同じ形。web は auth_uri / token_uri を見ず GOOGLE_TOKEN_URL を使う。 */
interface ServiceAccountKeyFile {
  type: "service_account";
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

function generate(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privatePem: privateKey, publicPem: publicKey };
}

/** 公開鍵を JWK にする (emulator の検証と /jwks が使う)。 */
function toJwk(publicPem: string): Record<string, unknown> {
  return createPublicKey(publicPem).export({ format: "jwk" }) as Record<string, unknown>;
}

/** 鍵から決まる ID を作る (同じ鍵なら同じ値になる)。 */
function fingerprint(publicPem: string): string {
  return createHash("sha256").update(publicPem).digest("hex");
}

/** SA の client_id は 21 桁の数字。鍵から決めて、実物と同じ見た目にする。 */
function clientIdFrom(hex: string): string {
  return (BigInt(`0x${hex.slice(0, 24)}`) % 10n ** 21n).toString().padStart(21, "0");
}

/**
 * 0600 で書く。先に一時ファイルへ書いてから rename する (途中の状態を読ませない)。
 * ⚠ 親ディレクトリも 0700 で作る。中身は秘密鍵なので、他のユーザーから一覧できないようにする。
 */
function writeSecurely(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function isUsable(parsed: unknown): parsed is ServiceAccountKeyFile {
  const key = parsed as Partial<ServiceAccountKeyFile> | null;
  return Boolean(key && key.client_email && key.private_key);
}

/**
 * ダミー SA 鍵を用意して、.dev.vars に入れる 1 行の JSON を返す。
 * 既にあればそれを読むだけ (作り直さない)。
 */
export function ensureEmulatorSaKey(
  root: string,
  warn: (message: string) => void = () => {},
): string {
  const saPath = join(root, SA_KEY_REL);

  if (existsSync(saPath) && existsSync(join(root, EMULATOR_KEYS_REL))) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(saPath, "utf8"));
      if (isUsable(parsed)) return JSON.stringify(parsed);
      warn(`${SA_KEY_REL} に client_email / private_key がありません。作り直します。`);
    } catch {
      warn(`${SA_KEY_REL} を JSON として読めません。作り直します。`);
    }
  }

  const sa = generate();
  const google = generate();
  const saFingerprint = fingerprint(sa.publicPem);

  const saKey: ServiceAccountKeyFile = {
    type: "service_account",
    project_id: `${PROJECT}-local`,
    private_key_id: saFingerprint.slice(0, 40),
    private_key: sa.privatePem,
    client_email: `ai-invoker-local@${PROJECT}.iam.gserviceaccount.com`,
    client_id: clientIdFrom(saFingerprint),
    // ⚠ 実物の SA 鍵と同じ形にするためだけ。web はここを見ず GOOGLE_TOKEN_URL を使う。
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
  };

  writeSecurely(saPath, `${JSON.stringify(saKey, null, 2)}\n`);
  writeSecurely(
    join(root, EMULATOR_KEYS_REL),
    `${JSON.stringify(
      {
        _comment: "gcp-emulator が読む鍵。sa は公開鍵だけ (秘密鍵は web の .dev.vars にしか無い)。",
        sa: {
          client_email: saKey.client_email,
          client_id: saKey.client_id,
          kid: saKey.private_key_id,
          jwk: toJwk(sa.publicPem),
        },
        google: {
          kid: fingerprint(google.publicPem).slice(0, 40),
          private_key_pem: google.privatePem,
          jwk: toJwk(google.publicPem),
        },
      },
      null,
      2,
    )}\n`,
  );

  return JSON.stringify(saKey);
}

function main() {
  // src/ → gcp-emulator → local → infra → リポジトリのルート
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const json = ensureEmulatorSaKey(root, (m) => console.error(`[keys][WARN] ${m}`));
  console.error(`[keys] ${SA_KEY_REL} / ${EMULATOR_KEYS_REL}`);
  console.error("[keys] 標準出力の 1 行を apps/web/.dev.vars に足してください (make keys >> apps/web/.dev.vars)。");
  console.log(`AI_INVOKER_SA_KEY='${json}'`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
