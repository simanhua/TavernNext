declare module '@agnai/sentencepiece-js' {
  export class SentencePieceProcessor {
    load(modelPath: string): Promise<void>;
    encodeIds(text: string): number[];
    encodePieces(text: string): string[];
    decodeIds(ids: number[]): string;
  }
}
