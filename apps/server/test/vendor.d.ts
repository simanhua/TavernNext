declare module 'png-chunks-extract' {
  interface PngChunk { name: string; data: Uint8Array }
  export default function extract(bytes: Uint8Array): PngChunk[];
}

declare module 'png-chunks-encode' {
  interface PngChunk { name: string; data: Uint8Array }
  export default function encode(chunks: PngChunk[]): Uint8Array;
}
