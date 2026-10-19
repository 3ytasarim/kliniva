"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/cn";

/**
 * Açılır panel (Radix). modal=false (varsayılan): kaydırma kilidi <style> enjekte ETMEZ → nonce'lu CSP ile uyumlu.
 * Konumlandırma istemcide CSSOM ile yapılır (satır içi stil özniteliği HTML'e yazılmaz).
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "animate-enter z-50 rounded-xl border border-line bg-white p-3 text-slate-900 shadow-raised outline-none dark:border-line-dark dark:bg-raised-dark dark:text-slate-100",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
