import type { ComponentProps, ReactNode } from "react";

type CardVariant = "default" | "accent";

type CardProps = {
  variant?: CardVariant;
  interactive?: boolean;
  children: ReactNode;
  className?: string;
} & Omit<ComponentProps<"div">, "children" | "className">;

const base = "rounded-md border p-5 sm:p-6";

const variantStyles: Record<CardVariant, string> = {
  default: "card-default",
  accent: "card-accent",
};

const interactiveStyles = "hover:-translate-y-0.5 transition-transform cursor-pointer";

export function Card({
  variant = "default",
  interactive = false,
  className = "",
  children,
  ...rest
}: CardProps) {
  const classes =
    `${base} ${variantStyles[variant]} ${interactive ? interactiveStyles : ""} ${className}`.trim();

  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}
