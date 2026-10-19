import * as React from "react";
import { cn } from "@/lib/cn";

/** Kart ailesi (shadcn/ui yapısı; Kliniva token'ları). */
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "rounded-xl border border-line bg-white shadow-card dark:border-line-dark dark:bg-surface-dark",
        className,
      )}
      {...props}
    />
  );
}
export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-5 pb-3 pt-4", className)} {...props} />
  );
}
export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("text-[15px] font-semibold tracking-tight", className)} {...props} />;
}
export function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("mt-0.5 text-xs text-slate-500 dark:text-slate-400", className)} {...props} />;
}
export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-5 pb-5", className)} {...props} />;
}
export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-t border-line px-5 py-3 dark:border-line-dark",
        className,
      )}
      {...props}
    />
  );
}
