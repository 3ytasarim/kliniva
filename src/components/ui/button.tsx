import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/** Düğme — tüm varyantlar tek kaynaktan (odak halkası, devre dışı, simge boyutu). asChild → Link vb. sarmalar. */
export const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out-expo focus-visible:outline-none focus-visible:shadow-focus active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-brand-600 font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_1px_2px_rgb(16_24_40/0.12)] hover:bg-brand-700",
        outline:
          "border border-line bg-white text-slate-700 shadow-[0_1px_2px_rgb(16_24_40/0.05)] hover:border-slate-300 hover:bg-slate-50 dark:border-line-dark dark:bg-surface-dark dark:text-slate-200 dark:hover:bg-raised-dark",
        secondary:
          "bg-slate-100 text-slate-800 hover:bg-slate-200 dark:bg-white/5 dark:text-slate-100 dark:hover:bg-white/10",
        ghost:
          "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white",
        destructive: "bg-red-600 font-semibold text-white hover:bg-red-700",
        link: "h-auto px-0 text-brand-700 underline-offset-4 hover:underline dark:text-brand-300",
      },
      size: {
        default: "min-h-11 px-4",
        sm: "min-h-9 rounded-md px-3 text-xs",
        lg: "min-h-12 px-6 text-[15px]",
        icon: "size-10",
        "icon-sm": "size-8 rounded-md",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
