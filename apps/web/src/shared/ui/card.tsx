import type { ComponentProps } from "react";
import { cn } from "./cn";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-surface-muted p-4", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("mb-2 text-sm font-semibold text-ink", className)} {...props} />;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-ink-muted">{children}</p>;
}
