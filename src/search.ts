import ytSearch, { VideoSearchResult } from 'yt-search';

/**
 * Performs a keyword search on YouTube and returns the first playable video match.
 */
export const findFirstVideo = async (query: string): Promise<VideoSearchResult | null> => {
  const searchResult = await ytSearch(query);
  const video = searchResult.videos?.[0] ?? null;
  return video ?? null;
};
