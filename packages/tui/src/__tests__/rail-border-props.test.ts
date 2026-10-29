import { describe, expect, it } from 'vitest';
import { railBorderProps } from '../ui/layout/Gutter.js';

describe('railBorderProps', () => {
  it('returns_the_same_borderStyle_object_for_the_same_rail', () => {
    expect(railBorderProps('│', 'red').borderStyle).toBe(railBorderProps('│', 'blue').borderStyle);
  });

  it('returns_distinct_borderStyle_objects_for_distinct_rails', () => {
    expect(railBorderProps('│').borderStyle).not.toBe(railBorderProps('|').borderStyle);
    expect(railBorderProps('|').borderStyle.left).toBe('|');
  });

  it('freezes_the_shared_style_so_no_caller_can_poison_it', () => {
    expect(Object.isFrozen(railBorderProps('│').borderStyle)).toBe(true);
  });

  it('keeps_only_the_left_edge_enabled', () => {
    const props = railBorderProps('│');
    expect([props.borderTop, props.borderBottom, props.borderRight, props.borderLeft])
      .toEqual([false, false, false, true]);
  });
});
