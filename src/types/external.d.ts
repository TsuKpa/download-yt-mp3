declare module 'yt-search' {
  export interface VideoSearchResult {
    videoId: string;
    title: string;
    description: string;
    url: string;
    timestamp: string;
    duration: { seconds: number; timestamp: string };
    views: number;
    author: string;
  }

  export interface SearchResult {
    videos: VideoSearchResult[];
  }

  function ytSearch(query: string): Promise<SearchResult>;

  export default ytSearch;
}
