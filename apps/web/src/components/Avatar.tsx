import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { initialsOf } from "../lib/format.js";

/**
 * Deterministic hue from a user id: the same user always gets the same
 * colour, on every device and after every reload. FNV-1a keeps it stable
 * across JS engines (a native hashCode is not guaranteed).
 */
export function hueOf(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/** Readable background/text pair derived from the user's stable hue. */
export function avatarColors(id: string): { background: string; color: string } {
  const hue = hueOf(id);
  return {
    background: `hsl(${hue} 55% 32%)`,
    color: `hsl(${hue} 90% 88%)`,
  };
}

/**
 * Fallback avatar shown whenever a user has no custom avatar: initials on a
 * colour derived from their user id. Pure function of its inputs, so the
 * server-rendered markup, the client and the tests all agree.
 */
export function GeneratedAvatar({
  id,
  name,
  size = 32,
}: {
  id: string;
  name: string;
  size?: number;
}): React.JSX.Element {
  const colors = avatarColors(id);
  return (
    <span
      aria-hidden="true"
      data-testid="generated-avatar"
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold"
      style={{
        display: "flex",
        flexShrink: 0,
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.4)),
        backgroundColor: colors.background,
        color: colors.color,
      }}
    >
      {initialsOf(name)}
    </span>
  );
}

export function Avatar({
  name,
  src,
  id,
  size = 32,
}: {
  name: string;
  src?: string | null;
  /** User id: seeds the deterministic colour of the generated fallback. */
  id?: string;
  size?: number;
}): React.JSX.Element {
  return (
    <AvatarPrimitive.Root
      // Root renders a <span>, which is an inline box where width/height are
      // ignored - that made the <img> inside fall back to its intrinsic 256px
      // size. `block` must therefore be inlined, not just put in className,
      // so the sizing cannot be lost by class order or CSS resets.
      className="block shrink-0 overflow-hidden rounded-full"
      style={{ display: "block", width: size, height: size, flexShrink: 0 }}
    >
      {src === null || src === undefined || src.length === 0 ? null : (
        <AvatarPrimitive.Image
          src={src}
          alt={`${name} avatar`}
          className="block h-full w-full object-cover"
        />
      )}
      <AvatarPrimitive.Fallback asChild>
        {id === undefined ? (
          <span
            className="flex h-full w-full items-center justify-center rounded-full text-xs font-semibold [background-color:var(--surface-3)]"
            style={{ color: "var(--accent)" }}
          >
            {initialsOf(name)}
          </span>
        ) : (
          // With a user id we can render a stable, per-user colour; without
          // one (e.g. a message author we only know by name) keep the
          // neutral surface so nothing pretends to be deterministic.
          <GeneratedAvatar id={id} name={name} size={size} />
        )}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
