/**
 * Turns assistant markdown into text a voice can read. Code blocks, images, and markup are noise
 * when spoken, so they are dropped; link and inline-code text is kept.
 */
export function markdownToSpeechText(markdown: string): string {
  return (
    markdown
      .replace(/\r\n?/g, "\n")
      // Fenced code blocks, including an unterminated one at the end of a streaming message.
      .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, "")
      .replace(/<[^>\n]+>/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1")
      .replace(/^[ \t]{0,3}#{1,6}\s+/gm, "")
      .replace(/^[ \t]{0,3}>\s?/gm, "")
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
      .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*(?:\n|$)/gm, "")
      .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, cells: string) =>
        cells
          .split("|")
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(", "),
      )
      .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Splits text into pieces no longer than `maxLength`, preferring paragraph, then sentence, then
 * word boundaries so each request ends where a reader would pause.
 */
export function splitSpeechText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = "";
  };
  const append = (piece: string, separator: string) => {
    if (!current) current = piece;
    else if (current.length + separator.length + piece.length <= maxLength) {
      current += separator + piece;
    } else {
      push();
      current = piece;
    }
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.length <= maxLength) {
      append(paragraph, "\n\n");
      continue;
    }
    for (const sentence of paragraph.match(/[^.!?\n]+(?:[.!?]+|\n|$)\s*/g) ?? [paragraph]) {
      if (sentence.length <= maxLength) {
        append(sentence.trim(), " ");
        continue;
      }
      for (const word of sentence.split(/\s+/)) {
        for (let start = 0; start < word.length; start += maxLength) {
          append(word.slice(start, start + maxLength), " ");
        }
      }
    }
  }
  push();
  return chunks;
}
