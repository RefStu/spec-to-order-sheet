-- ★★ セルの鍵を「相対」から「xlsx の絶対番地」に移し、ヘッダの値をセルの地図へ畳む。
--
-- ⚠⚠ これは **drizzle が作れないデータの移行**（手書き。`--custom` で枠だけ作った）。
--   鍵の式は `order-sheet-layout.ts` の `lineCellRef()` と**同じもの**:
--     行 = FIRST_BLOCK_ROW(15) + (line_no - 1) * BLOCK_ROWS(6) + VALUE_ROW(1) + 差
--   ⚠ 幾何を動かすときは、ここと同じ式でもう一度移行を書くこと
--     (`CELL_GEOMETRY_VERSION` を上げると order-sheet-layout.test.ts が落ちる)。
--
-- ⚠⚠ **これをやらないと値が消える。** `parseCells()` は知らない鍵を warn して捨てるので、
--   移行を忘れると画面からも xlsx からも明細の値が消え、**例外は出ない**。

-- 1) 明細のセルの地図: "D:0" -> "D16" (2 件目なら "D22")
--    ⚠ line_no > 12 の行があると枠の外の番地になる。適用前に 0 件であることを確かめること。
UPDATE order_sheet_lines
SET cells_json = (
  SELECT json_group_object(
    substr(je.key, 1, instr(je.key, ':') - 1)
      || (15 + (order_sheet_lines.line_no - 1) * 6 + 1
            + CAST(substr(je.key, instr(je.key, ':') + 1) AS INTEGER)),
    je.value
  )
  FROM json_each(order_sheet_lines.cells_json) AS je
)
WHERE cells_json IS NOT NULL
  AND cells_json <> ''
  AND cells_json LIKE '%:%';
--> statement-breakpoint

-- 2) ヘッダの値を cells_json へ畳む (J5=SHIP / J7=Customer PO / D12=PO / F12=SO)
--    ⚠ 空の欄は**鍵ごと入れない**（地図は疎に持つ）。
UPDATE order_sheets
SET cells_json = (
  SELECT json_group_object(k, v)
  FROM (
    SELECT 'J5' AS k, order_sheets.ship_date AS v
    UNION ALL SELECT 'J7', order_sheets.customer_po_no
    UNION ALL SELECT 'D12', order_sheets.po_no
    UNION ALL SELECT 'F12', order_sheets.so_no
  )
  WHERE v IS NOT NULL AND v <> ''
)
WHERE cells_json IS NULL;
--> statement-breakpoint

-- 3) 来歴の「列」も同じ番地に揃える。
--    ⚠⚠ **揃えないと正答率の集計が嘘をつく。** accuracy-service は
--      `target_table|target_row_id|target_column` の一致で「人が直したか」を数えるので、
--      読み取り側が "D:0"、修正側が "D16" だと**直した欄が「そのまま採用」に数えられる**。
--    ⚠ それ以前の世代 (`customer_item_code_text` など) は**触らない**。
--      `fieldKeyOfTarget()` が読めるようにしてあり、書き換えると由来が分からなくなる。
UPDATE ai_extraction_fields
SET target_column =
  substr(target_column, 1, instr(target_column, ':') - 1)
  || (15 + ((SELECT l.line_no FROM order_sheet_lines l WHERE l.id = ai_extraction_fields.target_row_id) - 1) * 6 + 1
        + CAST(substr(target_column, instr(target_column, ':') + 1) AS INTEGER))
WHERE target_table = 'order_sheet_lines'
  AND target_column LIKE '%:%'
  AND EXISTS (SELECT 1 FROM order_sheet_lines l WHERE l.id = ai_extraction_fields.target_row_id);
--> statement-breakpoint

UPDATE ai_field_corrections
SET target_column =
  substr(target_column, 1, instr(target_column, ':') - 1)
  || (15 + ((SELECT l.line_no FROM order_sheet_lines l WHERE l.id = ai_field_corrections.target_row_id) - 1) * 6 + 1
        + CAST(substr(target_column, instr(target_column, ':') + 1) AS INTEGER))
WHERE target_table = 'order_sheet_lines'
  AND target_column LIKE '%:%'
  AND EXISTS (SELECT 1 FROM order_sheet_lines l WHERE l.id = ai_field_corrections.target_row_id);
--> statement-breakpoint

-- 4) ヘッダの来歴も番地へ (発注No は AI の欄なので記録がある)。
--    ⚠ `partner_id` は**そのまま**。A12 は派生で、来歴の対象は外部キーの列そのもの。
UPDATE ai_extraction_fields SET target_column = 'J7'
  WHERE target_table = 'order_sheets' AND target_column = 'customer_po_no';
--> statement-breakpoint
UPDATE ai_field_corrections SET target_column = 'J7'
  WHERE target_table = 'order_sheets' AND target_column = 'customer_po_no';
