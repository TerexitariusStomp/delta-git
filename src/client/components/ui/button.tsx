import type { ComponentProps, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
type ButtonSize = "sm" | "md";

type ButtonBaseProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
  className?: string;
};

type ButtonAsButton = ButtonBaseProps &
  Omit<ComponentProps<"button">, keyof ButtonBaseProps> & {
    href?: never;
  };

type ButtonAsAnchor = ButtonBaseProps &
  Omit<ComponentProps<"a">, keyof ButtonBaseProps> & {
    href: string;
  };

export type ButtonProps = ButtonAsButton | ButtonAsAnchor;

const shared =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium no-underline hover:no-underline focus-visible:outline-none disabled:opacity-50 disabled:pointer-events-none transition-colors";

// GitHub button variants, bound to Primer control/button tokens.
const variants: Record<ButtonVariant, string> = {
  primary: "bg-btn text-btn-fg border border-btn-edge hover:bg-btn-hover active:bg-btn-active",
  secondary:
    "bg-control text-fg border border-control-edge hover:bg-control-hover active:bg-control-active",
  danger:
    "text-danger-fg border border-control-edge bg-control hover:bg-danger-fg hover:text-on-emphasis active:bg-control-active",
  ghost: "text-fg-muted hover:bg-control-hover hover:text-fg",
};

const sizes: Record<ButtonSize, string> = {
  sm: "px-3 py-[3px] text-xs leading-5",
  md: "px-3 py-[5px] text-sm leading-5",
};

export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md"): string {
  return `${shared} ${variants[variant]} ${sizes[size]}`;
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const classes = `${shared} ${variants[variant]} ${sizes[size]} ${className}`.trim();

  if ("href" in rest && rest.href != null) {
    const { href, ...anchorRest } = rest as ButtonAsAnchor;
    return (
      <a href={href} className={classes} {...anchorRest}>
        {children}
      </a>
    );
  }

  return (
    <button className={classes} {...(rest as Omit<ButtonAsButton, keyof ButtonBaseProps>)}>
      {children}
    </button>
  );
}
