export type DelimiterPair = {open: number; close: number};

const closers = new Map(Object.entries({'(': ')', '[': ']', '{': '}', '"': '"', "'": "'"}));

export function movePairs(pairs: readonly DelimiterPair[], start: number, end: number, length: number) {
  if (!pairs.length) return pairs;
  const delta = length - (end - start);
  return pairs.flatMap(({open, close}) => {
    if ((open >= start && open < end) || (close >= start && close < end)) return [];
    return [{open: open >= end ? open + delta : open, close: close >= end ? close + delta : close}];
  });
}

export function pairsAfterInput(pairs: readonly DelimiterPair[], before: string, after: string, beforeStart: number, afterEnd: number) {
  if (!pairs.length) return pairs;

  // Anchor the replacement at the new caret so identical adjacent delimiters stay distinct.
  const beforeEnd = afterEnd + before.length - after.length;
  if (beforeEnd < 0 || before.slice(beforeEnd) !== after.slice(afterEnd)) return [];

  let start = 0;
  const limit = Math.min(beforeStart, beforeEnd, afterEnd);
  while (start < limit && before[start] === after[start]) start++;
  return movePairs(pairs, start, beforeEnd, afterEnd - start);
}

export function delimiterKeyEdit(event: KeyboardEvent, editor: HTMLTextAreaElement, pairs: readonly DelimiterPair[]) {
  const {key} = event;
  const {selectionStart: start, selectionEnd: end} = editor;
  let {value} = editor;

  if (key === 'Backspace' || key === 'Delete') {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || end - start > 1) return;
    const index = start === end && key === 'Backspace' ? start - 1 : start;
    const pair = pairs.find(({open, close}) => index === open || index === close);
    if (!pair) return;

    if (index === pair.open) {
      value = value.slice(0, pair.close) + value.slice(pair.close + 1);
      pairs = movePairs(pairs, pair.close, pair.close + 1, 0);
    }
    return {
      value: value.slice(0, index) + value.slice(index + 1), start: index, end: index,
      pairs: movePairs(pairs, index, index + 1, 0),
    };
  }

  if (event.metaKey || (event.ctrlKey && !event.getModifierState('AltGraph'))) return;
  const closer = closers.get(key);
  if (!closer && key !== ')' && key !== ']' && key !== '}') return;
  let beforeEscapes = start;
  while (value[beforeEscapes - 1] === '\\') beforeEscapes--;
  if ((start - beforeEscapes) % 2) return;

  if (start === end && key === value[start] && pairs.some(pair => pair.close === start)) {
    return {value, start: start + 1, end: start + 1, pairs};
  }
  if (!closer || (start === end && key === closer && /[\p{L}\p{M}\p{N}_]/u.test(value[start - 1] ?? ''))) return;

  return {
    value: value.slice(0, start) + key + value.slice(start, end) + closer + value.slice(end),
    start: start + 1, end: end + 1,
    pairs: [...movePairs(movePairs(pairs, end, end, 1), start, start, 1), {open: start, close: end + 1}],
  };
}
