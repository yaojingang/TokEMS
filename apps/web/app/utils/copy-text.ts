export interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

export async function copyPlainText(
  value: string,
  clipboard: ClipboardWriter | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.clipboard,
) {
  const text = value.trim();
  if (!text || !clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
