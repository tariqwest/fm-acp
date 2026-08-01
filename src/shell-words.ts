/** Minimal POSIX-ish shell word splitter for EXTRA_ARGS env vars. */
export function split(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const push = () => {
    if (cur.length > 0 || quote !== null) {
      out.push(cur);
      cur = "";
    }
  };

  while (i < input.length) {
    const ch = input[i]!;
    i += 1;

    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    cur += ch;
  }

  if (escaped) {
    throw new Error("dangling escape in shell words");
  }
  if (quote) {
    throw new Error(`unclosed ${quote} quote in shell words`);
  }
  push();
  return out;
}
