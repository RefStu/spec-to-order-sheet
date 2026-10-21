/**
 * アップロードで受け付ける形式。
 *
 * ⚠⚠ **正は `features/files/schema.ts` の `ACCEPTED_CONTENT_TYPES`(受け口の側)。**
 *   境界ルールで別の feature を import できないので、ここに**写して**ある。
 *   ずれていないことは `schema.test.ts` が突き合わせる (files 側と同じ作法)。
 * ⚠ いまは PDF だけ。画像や xlsx を受けるときは**受け口を先に**広げること
 *   (画面だけ広げると、選べるのに 400 で弾かれる)。
 */
export const ACCEPTED_CONTENT_TYPES = ["application/pdf"] as const;

/** `<input accept>` に渡す文字列。 */
export const ACCEPT_ATTRIBUTE = ACCEPTED_CONTENT_TYPES.join(",");
