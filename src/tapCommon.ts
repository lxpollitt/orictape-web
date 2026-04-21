/**
 * Shared TAP file constants and types used by both the encoder and decoder.
 */

/** Magic string used to identify ORICTAPE metadata appended to a TAP block. */
export const TAP_META_MAGIC = 'ORICTAPE_META';

/**
 * Shape of the JSON metadata embedded in a TAP file.
 * See encodeTapMetadata in tapEncoder.ts for details of the structure.
 */
export interface TapMetadata {
  format?: 'fast' | 'slow';
  source?: string;
  chkErr?: number[];
  unclear?: number[];
  edited?: { explicit?: number[]; automatic?: number[] };
  lineDeltas?: { [l: string]: { i: number; v: number | number[] }[] };
  ignoreLineErrors?: number[];
}
