import chalk from "chalk";
import { twitter } from "../twitter";
import { Tweet } from "../twitter/schemas";
import { tweetsToString } from "../twitter/getUserContext";
import { SearchResult } from "../youtube/search";
import { yt } from "../youtube";
import { Failure, Success, failure, success } from "./run";
import { TranscriptCue } from "../youtube/transcript";
import { PipelineArgs, pipelineArgsSchema } from "./pipeline";
import { TranscriptClip } from "../recommender/prompts/recommendClips/helpers/transcriptClip";
import { createYouTubeSearchQueries } from "../recommender/prompts/createQueries/createQueries";
import { recommendVideos } from "../recommender/prompts/recommendVideos/recommendVideos";
import { appraiseTranscript } from "../recommender/prompts/appraiseTranscript/appraiseTranscript";
import { recommendClips } from "../recommender/prompts/recommendClips/recommendClips";
import { rerankClips } from "../recommender/prompts/rerankClips/rerankClips";
import { pAll } from "./utils/pAll";
import { shuffle } from "./utils/shuffle";
import { chunk } from "remeda";
import { chunkClipArray } from "./utils/chunkClipArray";
import { createRequestTags } from "../openpipe/requestTags";
import { transcriptClipsToString } from "../recommender/prompts/rerankClips/helpers/transcriptClipsToString";

export const STAGES = [
  "validate-args",
  "get-tweets",
  "create-queries",
  "search-for-videos",
  "filter-search-results",
  "download-transcripts",
  "appraise-transcripts",
  "chunk-transcripts",
  "order-clips",
] as const;

export const validateArgs = {
  name: "validate-args",
  description: "Validate arguments",
  run: async function (
    args: PipelineArgs
  ): Promise<Success<PipelineArgs> | Failure> {
    const maybeArgs = pipelineArgsSchema.safeParse(args);
    if (!maybeArgs.success) {
      return failure(maybeArgs.error);
    }
    return success(args);
  },
};

interface GetTweetsStageArgs extends PipelineArgs {}

export const getTweets = {
  name: "get-tweets",
  description: "Get tweets from Twitter user",
  run: async function (
    args: GetTweetsStageArgs
  ): Promise<Success<CreateQueriesStageArgs> | Failure> {
    const { user } = args;
    console.log(
      chalk.blue(`Creating recommendations for Twitter user @${user}`)
    );

    // get user context

    console.log(chalk.blue("Fetching tweets..."));
    const tweets = (
      await twitter.tweets.fetch({
        user,
        n_tweets: 30,
      })
    ).slice(0, 30);
    if (!tweets.length) {
      console.log(chalk.red("No tweets found"));
    } else {
      console.log(chalk.green(tweets.length + " tweets fetched successfully"));
    }
    return success({ ...args, tweets });
  },
};

interface CreateQueriesStageArgs extends PipelineArgs {
  tweets: Tweet[];
}

export const createQueries = {
  name: "create-queries",
  description: "Create queries for YouTube search",
  run: async function (
    args: CreateQueriesStageArgs
  ): Promise<Success<SearchForVideosStageArgs> | Failure> {
    const { tweets, user } = args;
    console.log(chalk.blue("Creating search queries..."));
    const { queries } = await createYouTubeSearchQueries().execute({
      enableOpenPipeLogging: args.enableLogging,
      openPipeRequestTags: createRequestTags(args),
      tweets,
      user,
    });
    if (!queries.length) {
      const msg = "No search queries generated";
      console.log(chalk.red(msg));
      return failure(msg);
    }

    const queriesWithTweets = queries.map(({ query, tweetIDs }) => ({
      query,
      tweets: tweetIDs.map((id) => tweets[id]),
    }));
    console.log(chalk.green("Created " + queries.length + " search queries"));
    for (let i = 0; i < queriesWithTweets.length; i++) {
      const { query, tweets } = queriesWithTweets[i];
      console.log("-----------------");
      console.log(chalk.blue(i + ". " + query));
      console.log(tweetsToString({ tweets, user }));
    }
    return success({ ...args, queriesWithTweets });
  },
};

interface SearchForVideosStageArgs extends CreateQueriesStageArgs {
  queriesWithTweets: {
    query: string;
    tweets: Tweet[];
  }[];
}

type SearchResultsWithTweets = {
  searchResults: SearchResult[];
  query: string;
  tweets: Tweet[];
};

export const searchForVideos = {
  name: "search-for-videos",
  description: "Search for videos on YouTube",
  run: async function (
    args: SearchForVideosStageArgs
  ): Promise<Success<FilterSearchResultsStageArgs> | Failure> {
    const { queriesWithTweets } = args;

    console.log(chalk.blue("Searching YouTube..."));

    const rawSearchResults: SearchResultsWithTweets[] = await pAll(
      queriesWithTweets.map(({ query, tweets }) => async () => {
        const rawSearchResultsForQuery = await yt.search({
          query,
        });
        console.log(
          chalk.blue(
            rawSearchResultsForQuery
              .map((result, idx) => `${idx + 1}. ${result.title}`)
              .join("\n")
          )
        );
        return {
          query,
          tweets: tweets,
          searchResults: rawSearchResultsForQuery,
        };
      }),
      { concurrency: 3 }
    );
    console.log(
      chalk.blue("Found " + rawSearchResults.length + " search results")
    );
    return success({ ...args, rawSearchResults });
  },
};

interface FilterSearchResultsStageArgs extends SearchForVideosStageArgs {
  rawSearchResults: SearchResultsWithTweets[];
}

export const filterSearchResults = {
  name: "filter-search-results",
  description: "Filter search results",
  run: async function (
    args: FilterSearchResultsStageArgs
  ): Promise<Success<DownloadTranscriptsStageArgs> | Failure> {
    const { rawSearchResults, user } = args;

    console.log(chalk.blue("Filtering search results..."));
    const filteredResults: {
      searchResults: { result: SearchResult; relevance: number }[];
      query: string;
      tweets: Tweet[];
    }[] = await pAll(
      rawSearchResults.map(({ query, tweets, searchResults }) => async () => {
        const filteredResultsForQuery = await recommendVideos().execute({
          enableOpenPipeLogging: args.enableLogging,
          openPipeRequestTags: createRequestTags(args),
          user,
          query: query,
          results: searchResults,
          tweets,
        });
        const relevantResults = filteredResultsForQuery.filter(
          (result) => result.relevance > args.searchFilterRelevancyCutOff
        );

        return {
          query: query,
          tweets: tweets,
          searchResults: relevantResults,
        };
      }),
      { concurrency: 10 }
    );
    if (!filteredResults.length) {
      const msg = "No search results passed the search filter";
      console.log(msg);
      return failure(msg);
    }
    console.log(
      chalk.green("Search results that passed the initial search filter:")
    );
    console.log(
      filteredResults
        .flatMap((r) => r.searchResults)
        .map(({ result }, idx) => `${idx + 1}. ${result.title}`)
        .join("\n")
    );
    return success({ ...args, filteredResults });
  },
};

type SearchResultWithTranscript = {
  searchResult: SearchResult;
  tweets: Tweet[];
  cues: TranscriptCue[];
  query: string;
  relevance: number;
};

interface DownloadTranscriptsStageArgs extends SearchForVideosStageArgs {
  filteredResults: {
    searchResults: { result: SearchResult; relevance: number }[];
    query: string;
    tweets: Tweet[];
  }[];
}

export const downloadTranscripts = {
  name: "download-transcripts",
  description: "Download transcripts for videos",
  run: async function (
    args: DownloadTranscriptsStageArgs
  ): Promise<Success<AppraiseTranscriptsStageArgs> | Failure> {
    const { filteredResults } = args;
    console.log(
      chalk.blue(
        `Fetching ${
          filteredResults.flatMap((r) => r.searchResults).length
        } transcripts...`
      )
    );
    const resultsWithTranscripts: SearchResultWithTranscript[] = [];
    for (const results of filteredResults) {
      await pAll(
        results.searchResults.map((result) => async () => {
          const { id, title } = result.result;
          const fetchResult = await yt.transcript.fetch({ id, title });
          if (!fetchResult || !fetchResult.cues.length) {
            console.log("Skipping video without transcript");
            return;
          }
          resultsWithTranscripts.push({
            searchResult: result.result,
            cues: fetchResult.cues,
            tweets: results.tweets,
            query: results.query,
            relevance: result.relevance,
          });
        }),
        { concurrency: 3 }
      );
    }
    if (!resultsWithTranscripts.length) {
      const msg = "No transcripts fetched";
      console.log(chalk.red(msg));
      return failure(msg);
    } else {
      console.log(
        chalk.green(
          resultsWithTranscripts.length + " transcripts fetched successfully"
        )
      );
      return success({ ...args, resultsWithTranscripts });
    }
  },
};

interface AppraiseTranscriptsStageArgs extends DownloadTranscriptsStageArgs {
  resultsWithTranscripts: SearchResultWithTranscript[];
}

export const appraiseTranscripts = {
  name: "appraise-transcripts",
  description: "Appraise transcripts",
  run: async function (args: AppraiseTranscriptsStageArgs) {
    const { resultsWithTranscripts } = args;
    console.log(
      chalk.blue(`Appraising ${resultsWithTranscripts.length} transcripts...`)
    );
    const appraisedResults: SearchResultWithTranscript[] = (
      await pAll(
        resultsWithTranscripts.map((result) => async () => {
          const { recommend, reasoning } = await appraiseTranscript().execute({
            transcript: result.cues,
            title: result.searchResult.title,
            enableOpenPipeLogging: args.enableLogging,
            openPipeRequestTags: createRequestTags(args),
          });
          if (!recommend) {
            console.log(
              chalk.blue(
                `Rejecting video ${result.searchResult.title}. ${reasoning}`
              )
            );
            return;
          } else {
            console.log(
              chalk.green(
                `Accepting video ${result.searchResult.title}. ${reasoning}`
              )
            );
            return result;
          }
        }),
        { concurrency: 10 }
      )
    ).filter(Boolean) as SearchResultWithTranscript[];
    if (!appraisedResults.length) {
      const msg = "No transcripts passed the appraisal filter";
      console.log(chalk.red(msg));
      return failure(msg);
    } else {
      console.log(
        chalk.green(
          appraisedResults.length + " transcripts passed the appraisal filter"
        )
      );
      return success({ ...args, appraisedResults });
    }
  },
};

interface ChunkTranscriptsStageArgs extends AppraiseTranscriptsStageArgs {
  appraisedResults: SearchResultWithTranscript[];
}

export const chunkTranscripts = {
  name: "chunk-transcripts",
  description: "Chunk transcripts",
  run: async function (args: ChunkTranscriptsStageArgs): Promise<
    | Success<
        ChunkTranscriptsStageArgs & {
          chunkedTranscripts: TranscriptClip[];
        }
      >
    | Failure
  > {
    const { appraisedResults, user } = args;
    const chunkedTranscripts: TranscriptClip[] = (
      await pAll(
        appraisedResults.map((result) => async () => {
          const chunks = await recommendClips().execute({
            tweets: result.tweets,
            openPipeRequestTags: createRequestTags(args),
            enableOpenPipeLogging: args.enableLogging,
            user,
            transcript: result.cues,
            title: result.searchResult.title,
            url: "https://www.youtube.com/watch?v=" + result.searchResult.id,
            videoId: result.searchResult.id,
          });
          if (!chunks.length) {
            console.log(
              chalk.red(
                "No chapters generated for " + result.searchResult.title
              )
            );
            return;
          } else {
            console.log(
              chalk.green(
                `${chunks.length} chapters generated for "${result.searchResult.title}"`
              )
            );
            console.log(chunks);
            return chunks;
          }
        }),
        { concurrency: 10 }
      )
    )
      .filter(Boolean)
      .flat() as TranscriptClip[];

    if (!chunkedTranscripts.length) {
      const msg = "No transcripts chunked";
      console.log(chalk.red(msg));
      return failure(msg);
    } else {
      console.log(
        chalk.green(
          chunkedTranscripts.length + " transcripts chunked successfully"
        )
      );
      return success({ ...args, chunkedTranscripts });
    }
  },
};

interface RankClipsStageArgs extends ChunkTranscriptsStageArgs {
  chunkedTranscripts: TranscriptClip[];
}

export const rankClips = {
  name: "order-clips",
  description: "Order Clips",
  run: async function (args: RankClipsStageArgs): Promise<
    | Success<
        RankClipsStageArgs & {
          orderedClips: TranscriptClip[];
        }
      >
    | Failure
  > {
    // order globally over all transcripts and all clips
    const allClips = shuffle(args.chunkedTranscripts);
    console.log(chalk.blue(`Ordering ${allClips.length} clips...`));

    // each window contains 8 clips
    // we order then discard the bottom 4 clips
    // we do some special handling for clips from the
    // same video to ensure we don't have too many clips from the same video
    const maxDesiredNumClips = 30;
    // TODO: don't hardcode
    const maxTokens =
      8192 -
      // for output
      500 -
      (
        await rerankClips().calculateCost({
          clips: "",
          tweets: tweetsToString({ tweets: args.tweets, user: args.user }),
        })
      ).total;
    const ratioToDiscard = 0.5;
    const maxClipsPerVideo = 3;

    let remainingClips = allClips;

    // TODO: what if we start with less than maxDesired clips?
    while (remainingClips.length > maxDesiredNumClips) {
      let chunked = await chunkClipArray({
        clips: remainingClips,
        maxTokensPerChunk: maxTokens,
        shuffle: true,
      });
      remainingClips = (
        await pAll(
          chunked.map((chunk) => async () => {
            const orderedClips = await rerankClips({
              windowSize: chunk.length,
              numToDiscard:
                chunk.every((clip) => clip.videoId === chunk[0]?.videoId) &&
                chunk.length > maxClipsPerVideo
                  ? chunk.length - maxClipsPerVideo
                  : Math.floor(chunk.length * ratioToDiscard),
            }).execute({
              enableOpenPipeLogging: args.enableLogging,
              openPipeRequestTags: createRequestTags(args),
              user: args.user,
              tweets: args.tweets,
              clips: chunk,
            });
            return orderedClips;
          }),
          {
            concurrency: 10,
          }
        )
      ).flat();
      console.log(chalk.blue(`Remaining clips: ${remainingClips.length}`));
    }

    return success({ ...args, orderedClips: remainingClips });
  },
};
