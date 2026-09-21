export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === undefined || parts[0].length === 0) {
    return "?";
  }
  const first = parts[0][0] ?? "?";
  const second = parts.length > 1 ? (parts[1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

export function displayNameOf(displayName: string, username: string): string {
  return displayName.trim().length > 0 ? displayName : username;
}

export function formatMessageTime(iso: string): { time: string; title: string } {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const title = date.toLocaleString();
  return { time, title };
}
