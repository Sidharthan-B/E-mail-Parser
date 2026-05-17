declare module "word-extractor" {
  class Document {
    getBody(): string;
  }

  class WordExtractor {
    extract(input: string | Buffer): Promise<Document>;
  }

  export default WordExtractor;
}
