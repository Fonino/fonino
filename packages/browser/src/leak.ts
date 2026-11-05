// Last line of defence: a secret the browser filled must never come back out in a tool result,
// a log line or a recording (pages sometimes echo a username, or show a field's value).
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) if (s.length >= 3) out = out.split(s).join("[secret]");
  return out;
}
