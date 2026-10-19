import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Sınıf birleştirme (çakışan Tailwind sınıflarında sonuncusu kazanır). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
