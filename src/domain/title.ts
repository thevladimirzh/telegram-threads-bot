/**
 * Title validation (D22/D38/D63, R19): 1..255 Unicode code points after
 * trimming leading/trailing whitespace.
 */

export interface TitleResult {
  ok: boolean;
  title: string;
  codePointLength: number;
}

export const MAX_TITLE_CODE_POINTS = 255;

export function validateTitle(raw: string): TitleResult {
  const title = raw.trim();
  const codePointLength = [...title].length;
  return {
    ok: codePointLength >= 1 && codePointLength <= MAX_TITLE_CODE_POINTS,
    title,
    codePointLength,
  };
}
