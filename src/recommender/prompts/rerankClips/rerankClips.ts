import { Prompt } from "prompt-iteration-assistant";
import {
  RerankClipsInput,
  rerankClipsInputSchema,
} from "./schemas/rerankClipsInputSchema";
import { rerankClipsOutputSchema } from "./schemas/rerankClipsOutputSchema";
import { zeroShotPrompt } from "./prompts/withExample";
import { Tweet } from "../../../twitter/schemas";
import { tweetsToString } from "../../../twitter/getUserContext";
import { openpipe } from "../../../openpipe/openpipe";
import _ from "remeda";

export const RERANK_CLIPS = "Rerank Clips";

type Clip = {
  id: number;
  title: string;
  summary: string;
  text: string;
};

/**
 * To find the best video clips to show to the user, we use a re-ranking prompt loosely based on https://github.com/sunnweiwei/RankGPT.
 * To get around context length limitations in cases where there are many clips, we use a sliding window approach.
 * In each call we compare and order `windowSize` clips. The lowest ranked clip is discarded leaving us with `windowSize-1` clips
 */
export class RerankClips extends Prompt<
  typeof rerankClipsInputSchema,
  typeof rerankClipsOutputSchema
> {
  constructor(public windowSize = 4) {
    super({
      name: RERANK_CLIPS,
      description:
        "Order YouTube video clips based on their relevance to the user's interests.",
      prompts: [zeroShotPrompt],
      model: "gpt-4",
      input: rerankClipsInputSchema,
      output: rerankClipsOutputSchema,
      exampleData: [],
    });
  }

  async execute(args: {
    user: string;
    tweets: Tweet[];
    clips: Clip[];
    enableOpenPipeLogging?: boolean;
  }) {
    const callApi = async (windowClips: Clip[]) => {
      const promptVariables: RerankClipsInput = {
        tweets: tweetsToString({ tweets: args.tweets, user: args.user }),
        clips: windowClips
          .map((clip, i) =>
            `
ID: ${clip.id}
${clip.title}
${clip.summary}
${clip.text}
`.trim()
          )
          .join("\n---\n"),
      };
      const { orderedClipIds } = await openpipe.functionCall({
        function: {
          name: this.name,
          description: this.description,
          input: this.input!,
          output: this.output!,
        },
        vars: promptVariables,
        prompt: this.prompts[0],
        body: {
          max_tokens: this.max_tokens,
          temperature: this.temperature,
          model: this.model,
        },
        enableOpenPipeLogging: args.enableOpenPipeLogging,
      });
      return orderedClipIds.map((id) => windowClips[id]);
    };

    if (args.clips.length === 0) {
      return [];
    } else if (args.clips.length === 1) {
      return args.clips;
    } else {
      let topClips: Clip[] = [];
      const initialWindow = args.clips.slice(0, this.windowSize);
      // initial rank
      const orderedClips = await callApi(initialWindow);
      topClips = orderedClips.slice(0, this.windowSize - 1);
      // rank all
      for (let i = this.windowSize; i < args.clips.length; i++) {
        const window = topClips.concat(args.clips[i]);
        const orderedWindow = await callApi(window);
        // discard the bottom ranked clip
        topClips = orderedWindow.slice(0, this.windowSize - 1);
      }
      return _.uniq(topClips);
    }
  }
}

export const rerankClips = (windowSize?: number) => new RerankClips(windowSize);
