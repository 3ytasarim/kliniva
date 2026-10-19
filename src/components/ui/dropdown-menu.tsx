"use client";

import * as React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/cn";

/**
 * Açılır menü (Radix). modal=false varsayılan: modal mod kaydırma kilidi için <style> enjekte eder ve nonce'lu CSP
 * bunu engeller. Klavye (ok / Enter / Esc) ve odak yönetimi Radix'ten gelir.
 */
export function DropdownMenu({ modal = false, ...props }: React.ComponentProps<typeof Menu.Root>) {
  return <Menu.Root modal={modal} {...props} />;
}
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = "end",
  ...props
}: React.ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "animate-enter z-50 min-w-48 overflow-hidden rounded-xl border border-line bg-white p-1 text-slate-900 shadow-raised dark:border-line-dark dark:bg-raised-dark dark:text-slate-100",
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof Menu.Item> & { variant?: "destructive" }) {
  return (
    <Menu.Item
      className={cn(
        "relative flex min-h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[highlighted]:bg-slate-100 data-[disabled]:opacity-50 dark:data-[highlighted]:bg-white/5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-slate-400",
        variant === "destructive" &&
          "text-red-700 data-[highlighted]:bg-red-50 dark:text-red-400 dark:data-[highlighted]:bg-red-500/10 [&_svg]:text-current",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Menu.Label>) {
  return (
    <Menu.Label
      className={cn("px-2.5 py-2 text-xs text-slate-500 dark:text-slate-400", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn("-mx-1 my-1 h-px bg-line dark:bg-line-dark", className)} {...props} />;
}
