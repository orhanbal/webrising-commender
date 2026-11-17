import * as React from "react";

export type IconVariant = "Linear" | "Bold";
/** Same props as iconsax-reactjs icons, limited to the two variants the UI uses. */
export interface IconProps extends Omit<React.SVGAttributes<SVGSVGElement>, "color"> {
  variant?: IconVariant;
  color?: string;
  size?: string | number;
}
export type IconComponent = React.ForwardRefExoticComponent<IconProps & React.RefAttributes<SVGSVGElement>>;

/**
 * Builds an icon from Iconsax artwork drawn in currentColor. The `color` prop sets
 * the SVG's color, so the default keeps inheriting the surrounding text color.
 */
export function iconsaxIcon(name: string, linear: string, bold: string): IconComponent {
  const linearHtml = { __html: linear }, boldHtml = { __html: bold };
  const C = React.forwardRef<SVGSVGElement, IconProps>(({ variant = "Linear", color, size = 24, ...rest }, ref) =>
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" {...rest} ref={ref}
      color={color} dangerouslySetInnerHTML={variant === "Bold" ? boldHtml : linearHtml} />);
  C.displayName = name;
  return C;
}
