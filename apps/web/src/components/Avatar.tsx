import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { initialsOf } from "../lib/format.js";

export function Avatar({
  name,
  src,
  size = 32,
}: {
  name: string;
  src?: string | null;
  size?: number;
}): React.JSX.Element {
  return (
    <AvatarPrimitive.Root
      className="shrink-0 overflow-hidden rounded-full"
      style={{ width: size, height: size }}
    >
      {src === null || src === undefined || src.length === 0 ? null : (
        <AvatarPrimitive.Image
          src={src}
          alt={`${name} avatar`}
          className="h-full w-full object-cover"
        />
      )}
      <AvatarPrimitive.Fallback
        className="flex h-full w-full items-center justify-center rounded-full text-xs font-semibold [background-color:var(--surface-3)]"
        style={{ color: "var(--accent)" }}
      >
        {initialsOf(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
