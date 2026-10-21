import { memo, useCallback, useMemo, useState } from "react";
import { Button } from "../../../shared/ui/button";
import { Card, CardTitle } from "../../../shared/ui/card";
import { cn } from "../../../shared/ui/cn";
import { SpinnerIcon } from "../../../shared/ui/icons";
import { elapsedLabel } from "../lib/format";
import type { SaveOrderSheetInput } from "../hooks/use-cases";
import {
  draftKeyOf,
  qtyTotalOf,
  toSaveInput,
  unsavedItemsOf,
  withDraft,
  type Draft,
} from "../lib/order-sheet-draft";
import type { FieldValue, OrderSheet, OrderSheetLinePhoto } from "../lib/order-sheet-contract";
import {
  buildOrderSheetForm,
  type FieldSpec,
  type LineCardSpec,
  type SectionSpec,
} from "../lib/order-sheet-sections";
import { FieldLegend } from "./FieldLegend";
import { OrderSheetField } from "./OrderSheetField";
import { PhotoCell } from "./PhotoCell";
import { UnsavedExportDialog } from "./UnsavedExportDialog";

/**
 * ORDER SHEET を**転記のための GUI** で出す。
 *
 * ⚠⚠ **紙の格子を再現しない。** 帳票は **A..L × 1..88 の 1 枚の格子**（約 1000 セル）だが、
 *   1000 セルの格子は Web では見にくいので、区画（セクション）と入力欄の形にした。
 *   ⚠ 実物との突き合わせは `xlsx で出す` で行う（画面の仕事ではない）。
 *
 * ⚠⚠ **保存する形は 1 文字も変えていない。** セルの鍵は xlsx の絶対番地（`"F16"`）のままで、
 *   `cells_json` も API の契約も xlsx も前のとおり。変わったのは見せ方だけ。
 * ⚠⚠ **どの欄が AI でどの欄が人かをここに書かない。** 全部の欄を同じように出し、
 *   塗り分けは `OrderSheetField` が filledBy / confidence / corrected だけで決める。
 *   ⚠ 区画分けは**紙の場所**による分類であって、「AI の欄 / 人の欄」ではない。混ぜないこと。
 * ⚠ **保存は PATCH 経由だけ。** 直接 DB を書かない。
 * ⚠ **AI の欄を人が直したら corrections に載せる**（正答率の分母）。
 *
 * ⚠⚠ **分岐をこの部品に持ち込まない。** 区画・欄・記入例・打てるかどうかは
 *   `lib/order-sheet-sections.ts` の `buildOrderSheetForm()`（純関数。テストがある）が決め、
 *   ここは**返ってきたものを描くだけ**。下書きと保存は `lib/order-sheet-draft.ts`。
 */

export function OrderSheetPanel({
  sheet,
  saving,
  ingesting = false,
  ingestingSince = null,
  exporting = false,
  onSave,
  onExport,
  onRequestDeletePhoto,
  deletingPhoto = false,
  onUploadPhoto,
  uploadingPhoto = false,
}: {
  sheet: OrderSheet;
  saving: boolean;
  /** その発注がまだ取り込み中か。⚠⚠ **取り込み中は 1 欄も触らせない。** */
  ingesting?: boolean;
  /** 取り込みが始まった時刻。⚠ パネルに**1 回だけ**出す (欄ごとに出さない)。 */
  ingestingSince?: string | null;
  exporting?: boolean;
  /**
   * ⚠⚠ **このパネルは mutate しない。** 保存は呼び出し側の PATCH だけ。
   * ⚠ **終わるまで待てる形で返す**（失敗は reject）。下書きは成功したときだけ消し、
   *   「保存してから xlsx で出す」は保存が済んでから書き出す。
   */
  onSave: (input: SaveOrderSheetInput) => Promise<void>;
  onExport?: () => void;
  onRequestDeletePhoto?: (photo: OrderSheetLinePhoto & { lineId: string }) => void;
  /** ★ 代表の図を足す。⚠ パネルは mutate しない (撃つのは呼び出し側)。 */
  onUploadPhoto?: (input: { lineId: string; file: File }) => void;
  uploadingPhoto?: boolean;
  deletingPhoto?: boolean;
}) {
  const [draft, setDraft] = useState<Draft>({});
  const [saveError, setSaveError] = useState<string | undefined>();
  /** 「xlsx で出す」の確認ダイアログを開いているか。 */
  const [confirmingExport, setConfirmingExport] = useState(false);

  /**
   * ⚠⚠ **stable な参照を保つこと。** 欄は明細 12 件 × 14 で 170 ほどある。
   *   毎打鍵でこの関数の参照が変わると `memo` が全部素通りして、
   *   1 文字ごとに全欄が描き直される。
   */
  const onFieldChange = useCallback((scope: string, ref: string, value: FieldValue) => {
    setDraft((prev) => ({ ...prev, [draftKeyOf(scope, ref)]: value }));
  }, []);

  const form = useMemo(() => buildOrderSheetForm(sheet, ingesting), [sheet, ingesting]);
  const qtyTotal = qtyTotalOf(form, draft);
  /**
   * ★ まだ保存していない項目（保存済みの値と違う下書き）。保存ボタンの横の印と
   *   「xlsx で出す」の確認は、これ 1 つで決める。
   * ⚠⚠ **xlsx は D1 の保存済みの値から作る。** 保存せずに出すと、打った文字が黙って入らない。
   */
  const unsaved = useMemo(() => unsavedItemsOf(form, draft), [form, draft]);
  const dirty = unsaved.length > 0;

  /**
   * 下書きを保存する。成功したら true。
   * ⚠⚠ **下書きは成功してから消す。** 先に消すと、PATCH が落ちたときに打った文字が
   *   画面からも消え、何も知らされない。
   * ⚠ 消すのは**送った値のままの欄だけ**。保存中に打ち足した欄は残す。
   */
  const saveDraft = async (): Promise<boolean> => {
    const sent = draft;
    setSaveError(undefined);
    try {
      await onSave(toSaveInput(sheet, sent));
      setDraft((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([key, value]) => sent[key] !== value)),
      );
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存できませんでした");
      return false;
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">ORDER SHEET</h2>
        {/*
          ★ 読み取り中であることと、**いつから**かを 1 か所で出す。
          ⚠ 取り残し (`JOB_STALE_MS` 超え) はここに出ない — 「失敗した」に倒れるので、
            人は「読み取りをやり直す」に進める (`shared/ai-jobs.ts`)。
        */}
        {ingesting ? (
          <span className="flex items-center gap-1.5 text-xs text-ink-muted">
            AI が読み取り中
            {elapsedLabel(ingestingSince) ? ` (${elapsedLabel(ingestingSince)})` : null}
            <SpinnerIcon width={12} height={12} />
          </span>
        ) : null}
        <span className="flex-1" />
        {/*
          ★ xlsx で出す。**実物と同じ雛形**に値を差し込む。
          ⚠ 画面はこの xlsx を読まない。**値の正は D1** で、これは出口の変換だけ。
          ⚠⚠ **実物と 1 文字も違わないことを確かめるのはこちら。** 画面ではない。
        */}
        {onExport ? (
          <Button
            variant="outline"
            size="sm"
            // ⚠ 未保存の項目があれば、出す前に確認する（保存してから出す / 保存せずに出す）。
            onClick={() => (dirty ? setConfirmingExport(true) : onExport())}
            disabled={exporting}
          >
            {exporting ? "作っています…" : "xlsx で出す"}
          </Button>
        ) : null}
        {saveError && !confirmingExport ? (
          <span role="alert" className="text-xs font-medium text-danger">
            {saveError}
          </span>
        ) : null}
        <Button
          size="sm"
          // ⚠ 取り込み中は保存も止める (欄が触れないのにボタンだけ押せると迷う)。
          disabled={!dirty || saving || ingesting}
          onClick={() => void saveDraft()}
          className="relative"
          title={dirty ? `保存していない項目が ${unsaved.length} 件あります` : undefined}
        >
          {/*
            ★ 未保存の印。**ボタンの中の左上**に点を重ねる（保存するまで消えない）。
            ⚠ `absolute` にして**幅を変えない**（点の有無でボタンが伸び縮みしない）。
              左上の角なので、左右の余白 (px-3) の中に収まり文字とも重ならない。
            ⚠ 色だけに頼らない（読み上げ用の文と title を付ける）。
          */}
          {dirty ? (
            <span className="absolute left-1 top-1 size-2 rounded-full bg-danger">
              <span className="sr-only">保存していない項目が {unsaved.length} 件あります</span>
            </span>
          ) : null}
          {saving ? "保存しています…" : "保存"}
        </Button>
      </div>

      {onExport ? (
        <UnsavedExportDialog
          items={confirmingExport ? unsaved : null}
          pending={saving}
          error={confirmingExport ? saveError : undefined}
          onCancel={() => setConfirmingExport(false)}
          onSaveAndExport={async () => {
            // ⚠ 保存が落ちたらダイアログを閉じない（理由を出し、選び直せるようにする）。
            if (!(await saveDraft())) return;
            setConfirmingExport(false);
            onExport();
          }}
          onExportAsIs={() => {
            setConfirmingExport(false);
            onExport();
          }}
        />
      ) : null}

      <FieldLegend />

      {/*
        ⚠⚠ **絞るのはここ 1 か所だけ。** `buildOrderSheetForm()` は 4 区画とも作る
          （画面に出さないだけで、API からも json からも xlsx からも外していない）。
          戻すときは `order-sheet-sections.ts` の `SECTION_VISIBLE` を `true` にする。
      */}
      {form.sections
        .filter((section) => section.visible)
        .map((section) => (
          <SheetSection
            key={section.id}
            section={section}
            total={section.lines.length > 0 ? { ...form.total, value: qtyTotal } : null}
            sheet={sheet}
            draft={draft}
            ingesting={ingesting}
            onFieldChange={onFieldChange}
            onRequestDeletePhoto={onRequestDeletePhoto}
            deletingPhoto={deletingPhoto}
            onUploadPhoto={onUploadPhoto}
            uploadingPhoto={uploadingPhoto}
          />
        ))}
    </section>
  );
}

function SheetSection({
  section,
  total,
  sheet,
  draft,
  ingesting,
  onFieldChange,
  onRequestDeletePhoto,
  deletingPhoto,
  onUploadPhoto,
  uploadingPhoto,
}: {
  section: SectionSpec;
  /** 合計本数。明細の区画にだけ付く。 */
  total: { label: string; unit: string; cell: string; value: number } | null;
  sheet: OrderSheet;
  draft: Draft;
  ingesting: boolean;
  onFieldChange: (scope: string, ref: string, value: FieldValue) => void;
  onRequestDeletePhoto?: (photo: OrderSheetLinePhoto & { lineId: string }) => void;
  /** ★ 代表の図を足す。⚠ パネルは mutate しない (撃つのは呼び出し側)。 */
  onUploadPhoto?: (input: { lineId: string; file: File }) => void;
  uploadingPhoto?: boolean;
  deletingPhoto: boolean;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="text-sm font-semibold text-ink">{section.title}</h3>
        {/*
          `G7` / `I<合計>` — 雛形の**数式**のセル（合計の行は明細の数で動く。2 件なら `I28`）。
          ⚠⚠ **画面が出すのは「Excel を開かなくても同じ数字が見える」ため**で、
            xlsx へは書き込まない (値で上書きすると合計が追従しなくなる)。
          ⚠ 下書きを含めて数えるので、保存前でも画面の数字と合う。
        */}
        {total ? (
          <span className="text-xs text-ink-muted" title={`xlsx の ${total.cell} と G7`}>
            {total.label}{" "}
            <span className="text-sm font-medium tabular-nums text-ink">{total.value}</span>{" "}
            {total.unit}
          </span>
        ) : null}
      </div>

      {/* ヘッダ側の区画。明細の区画では空配列なので何も出ない。 */}
      {section.fields.length > 0 ? (
        <Card className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {section.fields.map((spec) => (
            <DraftField
              key={spec.ref}
              spec={spec}
              draftValue={draft[draftKeyOf(spec.scope, spec.ref)]}
              confidenceThreshold={sheet.confidenceThreshold}
              ingesting={ingesting}
              onFieldChange={onFieldChange}
            />
          ))}
        </Card>
      ) : null}

      {/* 明細のカード。ヘッダの区画では空配列なので何も出ない。 */}
      {section.lines.map((card) => (
        <LineCard
          key={card.lineNo}
          card={card}
          draft={draft}
          confidenceThreshold={sheet.confidenceThreshold}
          ingesting={ingesting}
          onFieldChange={onFieldChange}
          onRequestDeletePhoto={onRequestDeletePhoto}
          deletingPhoto={deletingPhoto}
          onUploadPhoto={onUploadPhoto}
          uploadingPhoto={uploadingPhoto}
        />
      ))}
    </section>
  );
}

/**
 * 1 行に並べる欄の数 → 列の指定。
 *
 * ⚠ Tailwind は**書かれている文字列**しか拾わないので、`grid-cols-${n}` のような
 *   組み立ては効かない。**必ずベタ書きの一覧**にすること。
 * ⚠ 狭い画面では縦に落とす（`sm:` から横に並ぶ）。4 欄だけは 2 列 → 4 列と段を踏む。
 */
const ROW_COLUMNS: Readonly<Record<number, string>> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
};

/**
 * ★ 明細 1 件のカード。**左に代表の図、右に欄**。
 *
 * ⚠ 明細の無い枠と取り込み中の仮の明細は `editable: false` で来る（記述子が決める）。
 *   打てても writer が捨てるので、**打てるように見せない**こと。
 */
function LineCard({
  card,
  draft,
  confidenceThreshold,
  ingesting,
  onFieldChange,
  onRequestDeletePhoto,
  deletingPhoto,
  onUploadPhoto,
  uploadingPhoto,
}: {
  card: LineCardSpec;
  draft: Draft;
  confidenceThreshold: number;
  ingesting: boolean;
  onFieldChange: (scope: string, ref: string, value: FieldValue) => void;
  onRequestDeletePhoto?: (photo: OrderSheetLinePhoto & { lineId: string }) => void;
  /** ★ 代表の図を足す。⚠ パネルは mutate しない (撃つのは呼び出し側)。 */
  onUploadPhoto?: (input: { lineId: string; file: File }) => void;
  uploadingPhoto?: boolean;
  deletingPhoto: boolean;
}) {
  return (
    <Card className="grid grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
      <div className="flex flex-col gap-2">
        <CardTitle className="mb-0">{card.title}</CardTitle>
        {/*
          Picture。⚠ セルの地図には入らない（文字ではなく絵）が、塗り分けは同じに効く
            （`line.picture` も API が `by` / `filledBy` / `confidence` を付けて返す）。
        */}
        <OrderSheetField
          label={card.picture.label}
          field={card.picture.field}
          confidenceThreshold={confidenceThreshold}
          ingesting={ingesting}
          editable={false}
        >
          <PhotoCell
            size="lg"
            photos={card.picture.photos}
            fileId={card.picture.fileId}
            onRequestDelete={
              card.picture.deletable && onRequestDeletePhoto
                ? (photo) => onRequestDeletePhoto({ ...photo, lineId: card.lineId })
                : undefined
            }
            /*
              ⚠ 足せる条件はゴミ箱と同じ (`deletable`)。取り込み中の仮の明細や
                明細の無い枠には出さない (`lineId` が無い / writer が捨てる)。
            */
            onUpload={
              card.picture.deletable && onUploadPhoto
                ? (file) => onUploadPhoto({ lineId: card.lineId, file })
                : undefined
            }
            disabled={deletingPhoto || uploadingPhoto}
          />
        </OrderSheetField>
      </div>

      {/*
        ⚠⚠ **行の切り方は記述子が決める**（`order-sheet-sections.ts` の
          `LINE_ROWS`）。**DOM の順 = タブの順 = 転記の順**。
        ⚠ ここが決めるのは「その行を何列で並べるか」だけ。並べ替えの知識は持たない。
      */}
      <div className="flex flex-col gap-3">
        {card.rows.map((row) => (
          <div
            key={row[0]!.ref}
            className={cn("grid gap-3", ROW_COLUMNS[row.length] ?? "grid-cols-1")}
          >
            {row.map((spec) => (
              <DraftField
                key={spec.ref}
                spec={spec}
                draftValue={draft[draftKeyOf(spec.scope, spec.ref)]}
                confidenceThreshold={confidenceThreshold}
                ingesting={ingesting}
                onFieldChange={onFieldChange}
              />
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * ★★ 欄 1 つ。**`memo` で包むのが肝。**
 *
 * ⚠⚠ 下書きはパネルが持っているので、包まないと**1 文字打つたびに全欄が描き直される**。
 * ⚠⚠ **props を素の値に保つこと。** `field` を毎回組み立てて渡すと参照が変わって
 *   `memo` が効かない。`spec`（`useMemo` で作られた記述子。参照が安定している）と
 *   `draftValue`（素の値）を分けて渡し、**合成はこの中でやる**。
 */
const DraftField = memo(function DraftField({
  spec,
  draftValue,
  confidenceThreshold,
  ingesting,
  onFieldChange,
}: {
  spec: FieldSpec;
  draftValue: FieldValue | undefined;
  confidenceThreshold: number;
  ingesting: boolean;
  onFieldChange: (scope: string, ref: string, value: FieldValue) => void;
}) {
  return (
    <OrderSheetField
      label={spec.label}
      cellRef={spec.ref}
      field={withDraft(spec.field, draftValue)}
      confidenceThreshold={confidenceThreshold}
      ingesting={ingesting}
      editable={spec.editable}
      placeholder={spec.placeholder}
      prefix={spec.prefix}
      onChange={spec.editable ? (value) => onFieldChange(spec.scope, spec.ref, value) : undefined}
    />
  );
});

/*
  ⚠ 明細の枠は 12 個まで。**超える明細は xlsx の出口が 422 で断る** (黙って消さない)。
  ⚠⚠ **明細の無い枠は打たせない。** PATCH は既存の `lineId` を要求し、writer は
    知らない `lineId` を捨てるので、打てても**保存されず黙って消える**
    (`buildOrderSheetForm()` が `editable: false` にしている)。
  ⚠⚠ **画面に番地を文字として出さない。**実物の紙に印字されていないため。
    ホバーの tooltip には残してある (`OrderSheetField` の `cellRef`)。
*/
