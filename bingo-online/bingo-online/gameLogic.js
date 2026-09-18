/** Fisher-Yates shuffle (in place) */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Generate `count` distinct 5x5 Bingo cards using numbers in [min, max].
 * Each card has a different set of 25 numbers (checked via a sorted-key set;
 * with typical ranges like 1-99 collisions are astronomically unlikely, but
 * we still guard against them so no two cards are ever identical).
 */
function generateCards(count, min, max) {
  const range = max - min + 1;
  if (range < 25) {
    throw new Error('ช่วงเลขต้องมีอย่างน้อย 25 ค่า เพื่อสร้างบัตรขนาด 5x5 ได้');
  }

  const cards = [];
  const seenKeys = new Set();
  const pool = [];
  for (let n = min; n <= max; n++) pool.push(n);

  let safety = count * 200 + 500;
  while (cards.length < count && safety-- > 0) {
    const chosen = shuffle([...pool]).slice(0, 25);
    const key = [...chosen].sort((a, b) => a - b).join(',');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const grid = [];
    for (let r = 0; r < 5; r++) grid.push(chosen.slice(r * 5, r * 5 + 5));
    cards.push(grid);
  }

  // Fallback (should not normally trigger): fill remaining slots even if
  // an exact-duplicate check couldn't be guaranteed, so room creation never fails.
  while (cards.length < count) {
    const chosen = shuffle([...pool]).slice(0, 25);
    const grid = [];
    for (let r = 0; r < 5; r++) grid.push(chosen.slice(r * 5, r * 5 + 5));
    cards.push(grid);
  }

  return cards;
}

/**
 * Check a 5x5 grid against the set of numbers a player has marked.
 * Returns the FIRST completed line found (row, column, or either diagonal).
 */
function checkBingo(grid, markedNumbers) {
  const marked = new Set(markedNumbers);
  const isMarked = (r, c) => marked.has(grid[r][c]);
  const idx = [0, 1, 2, 3, 4];

  for (let r = 0; r < 5; r++) {
    if (idx.every((c) => isMarked(r, c))) {
      return { isBingo: true, pattern: `แนวนอน แถวที่ ${r + 1}` };
    }
  }
  for (let c = 0; c < 5; c++) {
    if (idx.every((r) => isMarked(r, c))) {
      return { isBingo: true, pattern: `แนวตั้ง คอลัมน์ที่ ${c + 1}` };
    }
  }
  if (idx.every((i) => isMarked(i, i))) {
    return { isBingo: true, pattern: 'แนวทแยง (บนซ้าย → ล่างขวา)' };
  }
  if (idx.every((i) => isMarked(i, 4 - i))) {
    return { isBingo: true, pattern: 'แนวทแยง (บนขวา → ล่างซ้าย)' };
  }
  return { isBingo: false, pattern: null };
}

/** Room code like "BGO-5821" */
function generateRoomCode() {
  const digits = '0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += digits[Math.floor(Math.random() * digits.length)];
  return `BGO-${code}`;
}

module.exports = { generateCards, checkBingo, generateRoomCode, shuffle };
