import { NodeList, parseSync } from "subtitle";
import { tokenize } from "./tokenize";

export interface TranscriptChunk {
  videoTitle: string;
  /**
   * URL of the source video.
   * Includes timestamp, eg. https://www.youtube.com/watch?v=videoId&t=1s
   */
  url: string;
  text: string;
  /**
   * The start of the chunk, in seconds.
   */
  start: number;
  /**
   * The end of the chunk, in seconds.
   */
  end: number;
}

export async function parseTranscript(args: {
  transcript: string;
  videoId: string;
  videoTitle: string;
}): Promise<TranscriptChunk[]> {
  const { transcript, videoId, videoTitle } = args;
  const parsedTranscript = parseSync(transcript);
  const chunks = parsedTranscript
    .filter((x) => x.type === "cue")
    .map((cue) => {
      const start =
        typeof cue.data === "string"
          ? 0
          : cue.data.start <= 10_000
          ? 0
          : Math.floor(cue.data.start / 1000);
      const end =
        typeof cue.data === "string" ? 0 : Math.ceil(cue.data.end / 1000);
      return {
        videoTitle,
        text: (typeof cue.data === "string" ? cue.data : cue.data.text)
          .trim()
          .replace(/\n/g, " ")
          .replace(/\&nbsp;/g, " ")
          // remove all tags
          .replace(/\[.*?\]/g, ""),
        type: "youtube",
        url: `https://www.youtube.com/watch?v=${videoId}&t=${start}s`,
        start,
        end,
      };
    })
    .filter((x) => !x.text.includes("<c>")) as TranscriptChunk[];
  return chunks;
}

async function mergeChunks(chunks: TranscriptChunk[], videoTitle: string) {
  let mergedChunks: TranscriptChunk[] = [];
  let tempText = "";
  let tempStart = 0;
  let tempEnd = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const newTokens = (await tokenize(chunk.text)).length;
    const existingTokens = (await tokenize(tempText)).length;

    if (existingTokens + newTokens <= 256) {
      tempText = tempText ? `${tempText} ${chunk.text}` : chunk.text;
      tempEnd = chunk.end;
      if (tempStart === 0) tempStart = chunk.start;
    } else {
      mergedChunks.push({
        text: tempText,
        url: chunk.url,
        start: tempStart,
        end: tempEnd,
        videoTitle,
      });
      tempText = chunk.text;
      tempStart = chunk.start;
      tempEnd = chunk.end;
    }
  }

  // Add any remaining text
  if (tempText) {
    mergedChunks.push({
      text: tempText,
      url: chunks[chunks.length - 1].url,
      start: tempStart,
      end: tempEnd,
      videoTitle,
    });
  }
}