/**
 * Torchaudio MMS FA post-normalize after uroman:
 * lowercase, keep a–z / apostrophe / space only, collapse whitespace.
 */
export function mmsNormalize(text: string): string {
  if (!text) {
    return text;
  }
  let out = text.toLowerCase();
  out = out.replace(/[’‘]/g, "'");
  out = out.replace(/[^a-z' ]+/g, ' ');
  out = out.replace(/ +/g, ' ').trim();
  return out;
}
