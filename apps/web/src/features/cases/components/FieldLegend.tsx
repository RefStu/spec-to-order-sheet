import { cn } from "../../../shared/ui/cn";
import { TONE_CLASS, TONE_LABEL, TONE_ORDER } from "../lib/field-style";

/** 塗り分けの凡例 (4 通り + 人が入れ終わった欄)。 */
export function FieldLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-ink-muted">
      {TONE_ORDER.map((tone) => (
        <span key={tone} className="flex items-center gap-1.5">
          <span className={cn("inline-block h-3 w-5 rounded border", TONE_CLASS[tone])} />
          {TONE_LABEL[tone]}
        </span>
      ))}
    </div>
  );
}
