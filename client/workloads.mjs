// One request URL, two attacker-chosen dimensions, and a route depth the
// application already has:
//
//   auxiliary outlets  x  distinct query names  x  empty-path depth
//
// Recognition walks every outlet the URL declares, an empty-path route matches
// each of them without consuming a segment, and every snapshot it builds copies
// the whole query map. The URL pays for the outlets and the names once each;
// the Router pays for their product.
//
// Nothing here is numeric, so this is not the V8 indexed-elements family that
// PR #70717 fixed.
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Shortest distinct ASCII spellings: 52 one-letter, then two, then three.
function keyAt(index) {
  const n = ALPHABET.length;
  if (index < n) return ALPHABET[index];
  let rest = index - n;
  if (rest < n * n) return ALPHABET[(rest / n) | 0] + ALPHABET[rest % n];
  rest -= n * n;
  return (
    ALPHABET[(rest / (n * n)) | 0] + ALPHABET[((rest / n) | 0) % n] + ALPHABET[rest % n]
  );
}

// "name:/()" is a named outlet holding an empty primary child group. The terser
// "name:" does not work: the parser folds the outlets into one group and the
// fan-out disappears.
function outlets(count) {
  return Array.from(
    { length: count },
    (_, index) => `${index ? "//" : ""}${keyAt(index)}:/()`,
  ).join("");
}

// The control keeps every byte, every outlet and every query pair, and changes
// only how many distinct names the query map ends up with: every name becomes a
// run of "a" of its own length, so "b" becomes "a" and "cd" becomes "aa". Same
// bytes, same pair count, one distinct name per length. The Router parses the
// same pairs and retains the same values either way.
export function buildTarget({ shape, mode, outletCount, queryNames }) {
  const names = Array.from({ length: queryNames }, (_, index) => keyAt(index));
  const query =
    mode === "control"
      ? names.map((name) => "a".repeat(name.length))
      : names;

  // A dimension set to zero contributes none of its own syntax: no empty "()"
  // group and no bare "?". That keeps each single-dimension arm at the bytes of
  // its own dimension alone.
  const path = outletCount ? `/${shape}/(${outlets(outletCount)})` : `/${shape}`;
  return queryNames ? `${path}?${query.join("&")}` : path;
}
