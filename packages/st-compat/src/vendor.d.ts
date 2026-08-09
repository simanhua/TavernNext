declare module 'png-chunks-extract' {
  interface PngChunk { name: string; data: Uint8Array }
  export default function extractChunks(data: Uint8Array): PngChunk[];
}

declare module 'png-chunks-encode' {
  interface PngChunk { name: string; data: Uint8Array }
  export default function encodeChunks(chunks: readonly PngChunk[]): Uint8Array;
}

declare module 'png-chunk-text' {
  export function decode(data: Uint8Array | { name: string; data: Uint8Array }): { keyword: string; text: string };
  export function encode(keyword: string, text: string): { name: 'tEXt'; data: Uint8Array };
}
