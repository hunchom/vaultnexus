/** Chunk tier: whole note, or a block-level span within it. */
export type Granularity = 'note' | 'block';

/** Offset-faithful unit of a parsed note. `text` === source UTF-8 bytes [byteStart, byteEnd). */
export interface Chunk {
  granularity: Granularity;
  text: string;
  byteStart: number;
  byteEnd: number;
  headingPath: string[]; // enclosing headings, outer→inner; [] at note root
}
